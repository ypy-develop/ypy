// SPDX-License-Identifier: MIT

package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// Minimal WebSocket server side (RFC 6455): handshake, text frames, ping/pong, close.
// Standard library only. Enough for the example apps; not a general purpose implementation.

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	mu     sync.Mutex
	conn   net.Conn
	closed bool
}

// Send writes one text frame. It is safe to call from several goroutines.
func (c *wsConn) Send(text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	_, _ = c.conn.Write(wsFrame(0x1, []byte(text)))
}

func (c *wsConn) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	_, _ = c.conn.Write(wsFrame(0x8, nil))
	_ = c.conn.Close()
}

func (c *wsConn) writeRaw(b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		_, _ = c.conn.Write(b)
	}
}

// acceptWebSocket performs the handshake and starts the read loop in a goroutine.
// onMessage is called for every complete text message; onClose once, when the
// connection ends. It returns nil when the request is not a valid upgrade.
func acceptWebSocket(w http.ResponseWriter, r *http.Request, onMessage func(string, *wsConn), onClose func()) *wsConn {
	key := r.Header.Get("Sec-WebSocket-Key")
	hj, ok := w.(http.Hijacker)
	if key == "" || !ok {
		http.Error(w, "bad websocket request", http.StatusBadRequest)
		return nil
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	lines := []string{
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]),
	}
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			lines = append(lines, "Sec-WebSocket-Protocol: "+p)
			break
		}
	}
	_, _ = conn.Write([]byte(strings.Join(lines, "\r\n") + "\r\n\r\n"))

	c := &wsConn{conn: conn}
	go func() {
		defer func() {
			c.mu.Lock()
			c.closed = true
			c.mu.Unlock()
			_ = conn.Close()
			if onClose != nil {
				onClose()
			}
		}()
		var fragments []byte
		var fragmentOpcode byte
		for {
			f, err := readFrame(rw.Reader)
			if err != nil {
				return
			}
			switch f.opcode {
			case 0x8:
				c.close()
				return
			case 0x9:
				c.writeRaw(wsFrame(0xA, f.payload))
			case 0xA:
				// pong: ignore
			default:
				if f.opcode != 0x0 {
					fragments = nil
					fragmentOpcode = f.opcode
				}
				fragments = append(fragments, f.payload...)
				if f.fin {
					data := fragments
					fragments = nil
					if fragmentOpcode == 0x1 && onMessage != nil {
						onMessage(string(data), c)
					}
				}
			}
		}
	}()
	return c
}

type frame struct {
	fin     bool
	opcode  byte
	payload []byte
}

func readFrame(r *bufio.Reader) (frame, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return frame{}, err
	}
	f := frame{fin: h[0]&0x80 != 0, opcode: h[0] & 0x0f}
	masked := h[1]&0x80 != 0
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return frame{}, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return frame{}, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > 1<<24 {
		return frame{}, io.ErrUnexpectedEOF
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return frame{}, err
		}
	}
	f.payload = make([]byte, n)
	if _, err := io.ReadFull(r, f.payload); err != nil {
		return frame{}, err
	}
	if masked {
		for i := range f.payload {
			f.payload[i] ^= mask[i%4]
		}
	}
	return f, nil
}

func wsFrame(opcode byte, payload []byte) []byte {
	n := len(payload)
	var header []byte
	switch {
	case n < 126:
		header = []byte{0x80 | opcode, byte(n)}
	case n < 65536:
		header = []byte{0x80 | opcode, 126, 0, 0}
		binary.BigEndian.PutUint16(header[2:], uint16(n))
	default:
		header = make([]byte, 10)
		header[0], header[1] = 0x80|opcode, 127
		binary.BigEndian.PutUint64(header[2:], uint64(n))
	}
	return append(header, payload...)
}
