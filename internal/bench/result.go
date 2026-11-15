// SPDX-License-Identifier: MIT

package bench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Ordered is a JSON object that keeps the order of its keys: results list
// their metrics in the order the scenarios produced them.
type Ordered[V any] struct {
	keys []string
	vals map[string]V
}

// Set adds or replaces a key; a new key goes last.
func (o *Ordered[V]) Set(key string, v V) {
	if o.vals == nil {
		o.vals = map[string]V{}
	}
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// Get returns the value of a key.
func (o *Ordered[V]) Get(key string) (V, bool) {
	v, ok := o.vals[key]
	return v, ok
}

// Keys returns the keys in order.
func (o *Ordered[V]) Keys() []string { return o.keys }

// Len is the number of keys.
func (o *Ordered[V]) Len() int { return len(o.keys) }

// MarshalJSON implements json.Marshaler.
func (o Ordered[V]) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := marshal(k)
		if err != nil {
			return nil, err
		}
		vb, err := marshal(o.vals[k])
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// UnmarshalJSON implements json.Unmarshaler.
func (o *Ordered[V]) UnmarshalJSON(data []byte) error {
	*o = Ordered[V]{}
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if tok == nil { // null
		return nil
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return fmt.Errorf("expected an object, got %v", tok)
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := kt.(string)
		var v V
		if err := dec.Decode(&v); err != nil {
			return err
		}
		o.Set(key, v)
	}
	_, err = dec.Token()
	return err
}

// marshal is json.Marshal without HTML escaping: notes contain "->".
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// Metric is the summary of one measured quantity. Every metric is "lower is
// better"; the unit says what it counts (ms, us, KB, B, count).
type Metric struct {
	Unit          string    `json:"unit"`
	LowerIsBetter *bool     `json:"lowerIsBetter,omitempty"`
	N             int       `json:"n"`
	Median        float64   `json:"median"`
	P95           float64   `json:"p95"`
	Min           float64   `json:"min"`
	Mean          float64   `json:"mean"`
	CV            float64   `json:"cv"`
	RoundMedians  []float64 `json:"roundMedians"`
	NoisePct      float64   `json:"noisePct"`
}

// Lower reports whether a smaller value is better (the default).
func (m Metric) Lower() bool { return m.LowerIsBetter == nil || *m.LowerIsBetter }

// Config is how a result was produced.
type Config struct {
	Rounds int     `json:"rounds"`
	Scale  float64 `json:"scale"`
	Quick  bool    `json:"quick"`
	Filter *string `json:"filter"`
}

// Environment is the machine and the browser of a result.
type Environment struct {
	Chrome string `json:"chrome"`
	// Node is only present in results recorded by the earlier harness.
	Node                string `json:"node,omitempty"`
	Go                  string `json:"go,omitempty"`
	OS                  string `json:"os"`
	CPU                 string `json:"cpu"`
	CrossOriginIsolated bool   `json:"crossOriginIsolated"`
}

// Checkpoint is a memory reading during the session scenario. At is a request
// count or "end".
type Checkpoint struct {
	At        any      `json:"at"`
	HeapUsed  float64  `json:"heapUsed"`
	Nodes     int64    `json:"nodes"`
	Listeners int64    `json:"listeners"`
	Documents int64    `json:"documents"`
	UAM       *float64 `json:"uam"`
}

// Result is the JSON file a run writes to bench/results.
type Result struct {
	Schema            int                   `json:"schema"`
	Date              string                `json:"date"`
	Time              string                `json:"time,omitempty"`
	SHA               string                `json:"sha"`
	Build             string                `json:"build"`
	Config            Config                `json:"config"`
	Environment       Environment           `json:"environment"`
	DurationSeconds   int                   `json:"durationSeconds"`
	Skipped           Ordered[string]       `json:"skipped"`
	Notes             Ordered[string]       `json:"notes"`
	MemoryCheckpoints Ordered[[]Checkpoint] `json:"memoryCheckpoints"`
	Metrics           Ordered[Metric]       `json:"metrics"`
}

// WriteJSON writes v as JSON indented by two spaces, like the earlier harness.
func WriteJSON(path string, v any) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}

// ReadResult reads a result file.
func ReadResult(path string) (*Result, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if r.Metrics.Len() == 0 {
		return nil, fmt.Errorf("%s: not a benchmark result (no metrics)", path)
	}
	return &r, nil
}

func discard() io.Writer { return io.Discard }
