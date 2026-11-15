// SPDX-License-Identifier: MIT

package assets

import (
	"fmt"
	"strings"
)

// Marker is the attribute that makes a <style> or <script> element an asset of
// the template that holds it.
const Marker = "ypy-asset"

// Block is one marked element found in a template.
type Block struct {
	Kind    Kind   // css or js
	Content string // what sits between the tags, newlines normalised to \n
	Line    int    // 1-based line of the opening tag
	// Start and End delimit the whole element in the source: the opening tag
	// through the closing tag.
	Start, End int
}

// Kind is the type of an asset.
type Kind string

// The two kinds of asset the tool extracts.
const (
	CSS Kind = "css"
	JS  Kind = "js"
)

// Scan finds the marked <style> and <script> elements of one template. It is a
// small scanner and not an HTML parser: it knows quoted attribute values and
// the raw text of the two elements, which is all a marked block needs.
//
// A marked block has to be extractable as it is, so Scan reports an error, with
// the line, when it is not: a <style> with a media attribute, a <script> that
// is a module or carries a type other than JavaScript, a block with no closing
// tag, and (when actions is true) a block that holds a template action.
func Scan(src string, actions bool) ([]Block, error) {
	var blocks []Block
	var errs []string
	for i := 0; i < len(src); {
		j := strings.IndexByte(src[i:], '<')
		if j < 0 {
			break
		}
		i += j
		name := ""
		switch {
		case hasTag(src, i, "style"):
			name = "style"
		case hasTag(src, i, "script"):
			name = "script"
		default:
			i++
			continue
		}
		start := i
		attrs, tagEnd, ok := parseTag(src, i+1+len(name))
		if !ok {
			i++
			continue
		}
		if _, marked := attrs[Marker]; !marked {
			i = tagEnd
			continue
		}
		line := 1 + strings.Count(src[:start], "\n")
		closeAt := indexClose(src, tagEnd, name)
		if closeAt < 0 {
			errs = append(errs, fmt.Sprintf("line %d: <%s %s> has no closing tag", line, name, Marker))
			break
		}
		end := closeAt + len("</"+name)
		if k := strings.IndexByte(src[end:], '>'); k >= 0 {
			end += k + 1
		} else {
			errs = append(errs, fmt.Sprintf("line %d: the closing tag of <%s %s> is not finished", line, name, Marker))
			break
		}
		content := normalize(src[tagEnd:closeAt])
		b := Block{Content: content, Line: line, Start: start, End: end}
		if name == "style" {
			b.Kind = CSS
			if _, has := attrs["media"]; has {
				errs = append(errs, fmt.Sprintf("line %d: <style %s> with a media attribute cannot join a stylesheet; put the condition in an @media rule", line, Marker))
			}
		} else {
			b.Kind = JS
			if _, has := attrs["src"]; has {
				errs = append(errs, fmt.Sprintf("line %d: <script %s> with a src attribute is not an inline script", line, Marker))
			}
			if t := strings.ToLower(strings.TrimSpace(attrs["type"])); t != "" && t != "text/javascript" && t != "application/javascript" {
				errs = append(errs, fmt.Sprintf("line %d: <script %s type=%q> cannot join a classic script; only JavaScript without type=module", line, Marker, attrs["type"]))
			}
		}
		if actions && strings.Contains(content, "{{") {
			errs = append(errs, fmt.Sprintf("line %d: <%s %s> holds a template action ({{ }}); an extracted file is static, pass values through CSS custom properties or data attributes", line, name, Marker))
		}
		blocks = append(blocks, b)
		i = end
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("%s", strings.Join(errs, "\n"))
	}
	return blocks, nil
}

// Strip returns src without the blocks. A block that sat alone on its line
// takes the whole line with it, so the template does not keep a blank gap.
func Strip(src string, blocks []Block) string {
	var b strings.Builder
	pos := 0
	for _, blk := range blocks {
		start, end := blk.Start, blk.End
		ls := strings.LastIndexByte(src[:start], '\n') + 1
		le := end
		for le < len(src) && (src[le] == ' ' || src[le] == '\t' || src[le] == '\r') {
			le++
		}
		if strings.TrimSpace(src[ls:start]) == "" && (le == len(src) || src[le] == '\n') {
			start = ls
			if le < len(src) {
				end = le + 1
			} else {
				end = le
			}
		}
		if start < pos {
			continue
		}
		b.WriteString(src[pos:start])
		pos = end
	}
	b.WriteString(src[pos:])
	return b.String()
}

// hasTag reports whether src[i:] opens the element name: "<name" followed by
// white space, "/" or ">", in any case.
func hasTag(src string, i int, name string) bool {
	n := 1 + len(name)
	if i+n >= len(src) || !strings.EqualFold(src[i+1:i+n], name) {
		return false
	}
	switch src[i+n] {
	case ' ', '\t', '\n', '\r', '\f', '/', '>':
		return true
	}
	return false
}

// parseTag reads the attributes of a start tag whose name ends at i. It returns
// them (names in lower case), the index after the closing ">" and whether the
// tag is complete.
func parseTag(src string, i int) (map[string]string, int, bool) {
	attrs := map[string]string{}
	for i < len(src) {
		switch c := src[i]; {
		case c == '>':
			return attrs, i + 1, true
		case c == '/' || isSpace(c):
			i++
		default:
			s := i
			for i < len(src) && !isSpace(src[i]) && src[i] != '=' && src[i] != '>' && src[i] != '/' {
				i++
			}
			name := strings.ToLower(src[s:i])
			for i < len(src) && isSpace(src[i]) {
				i++
			}
			val := ""
			if i < len(src) && src[i] == '=' {
				i++
				for i < len(src) && isSpace(src[i]) {
					i++
				}
				if i < len(src) && (src[i] == '"' || src[i] == '\'') {
					q := src[i]
					e := strings.IndexByte(src[i+1:], q)
					if e < 0 {
						return nil, 0, false
					}
					val = src[i+1 : i+1+e]
					i += e + 2
				} else {
					s := i
					for i < len(src) && !isSpace(src[i]) && src[i] != '>' {
						i++
					}
					val = src[s:i]
				}
			}
			if name != "" {
				attrs[name] = val
			}
		}
	}
	return nil, 0, false
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}

// indexClose finds "</name" (any case) at or after from, or -1.
func indexClose(src string, from int, name string) int {
	needle := "</" + name
	for i := from; i+len(needle) <= len(src); i++ {
		if src[i] == '<' && strings.EqualFold(src[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

// normalize turns CRLF and CR into LF, so the same source gives the same bytes
// on every system.
func normalize(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}
