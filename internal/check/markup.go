// SPDX-License-Identifier: MIT

package check

// Textual markup scanner. It never interprets a template language: it blanks
// out the template syntax (keeping every offset and newline), then walks the
// remaining text with a lenient tag tokenizer that builds a light element tree
// with line numbers.
//
// Supported by blanking: Go html/template, Jinja, Django, Twig, Blade, ERB,
// EJS and PHP blocks; templ files are handled by the attribute tokenizer
// (`attr={ expr }`).

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
)

var voidTags = map[string]bool{"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true, "img": true,
	"input": true, "link": true, "meta": true, "param": true, "source": true, "track": true, "wbr": true}

var rawTextTags = map[string]bool{"script": true, "style": true, "textarea": true, "title": true}

// blank replaces a region with spaces, keeping newlines and the byte length,
// so offsets and line numbers stay valid. fill is written at the start of the
// region (a masked attribute value is then not empty).
func blank(s string, fill string) string {
	b := []byte(s)
	for i, c := range b {
		if c != '\n' {
			b[i] = ' '
		}
	}
	if fill != "" && len(fill) <= len(b) {
		copy(b, fill)
	}
	return string(b)
}

var (
	reTwigComment  = regexp.MustCompile(`\{#[\s\S]*?#\}`)
	reBladeComment = regexp.MustCompile(`\{\{--[\s\S]*?--\}\}`)
	reGoComment    = regexp.MustCompile(`\{\{/\*[\s\S]*?\*/\}\}`)
	reStatement    = regexp.MustCompile(`\{%[\s\S]*?%\}`)
	reRawEcho      = regexp.MustCompile(`\{!![\s\S]*?!!\}`)
	reEcho         = regexp.MustCompile(`\{\{[\s\S]*?\}\}`)
	reERB          = regexp.MustCompile(`<%[\s\S]*?%>`)
	rePHP          = regexp.MustCompile(`<\?(?:php|=)?[\s\S]*?(?:\?>|$)`)
	reTagStart     = regexp.MustCompile(`<[A-Za-z]`)
	reGoBlock      = regexp.MustCompile(`@go\b[\s\S]*?@endgo\b`)
	reDirective    = regexp.MustCompile(`^@[A-Za-z_]\w*[ \t]*\(`)
	reKyseExt      = regexp.MustCompile(`(?:\.php|\.phtml|\.kyse\.go|\.blade\.php)$`)
)

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// maskDirectives blanks Blade-style directives such as @if(...), @class([...]):
// the name and the balanced parentheses (the argument may hold quotes and
// nested calls).
func maskDirectives(text string) string {
	var out strings.Builder
	i := 0
	for i < len(text) {
		if text[i] != '@' || (i > 0 && (isWordByte(text[i-1]) || text[i-1] == '@' || text[i-1] == '.')) {
			out.WriteByte(text[i])
			i++
			continue
		}
		hit := reDirective.FindString(text[i:])
		if hit == "" {
			out.WriteByte(text[i])
			i++
			continue
		}
		depth := 1
		j := i + len(hit)
		var quote byte
		for j < len(text) && depth > 0 {
			ch := text[j]
			switch {
			case quote != 0:
				if ch == '\\' {
					j++
				} else if ch == quote {
					quote = 0
				}
			case ch == '"' || ch == '\'' || ch == '`':
				quote = ch
			case ch == '(':
				depth++
			case ch == ')':
				depth--
			}
			j++
		}
		if j > len(text) {
			j = len(text)
		}
		out.WriteString(blank(text[i:j], ""))
		i = j
	}
	return out.String()
}

func replaceAll(re *regexp.Regexp, text, fill string) string {
	return re.ReplaceAllStringFunc(text, func(m string) string { return blank(m, fill) })
}

// maskTemplates blanks the template syntax of text; ext is the file extension
// (".php", ".kyse.go", ...) that tells which extra languages to mask.
func maskTemplates(text, ext string) string {
	t := text
	t = replaceAll(reTwigComment, t, "")
	t = replaceAll(reBladeComment, t, "")
	t = replaceAll(reGoComment, t, "")
	t = replaceAll(reStatement, t, "")
	t = replaceAll(reRawEcho, t, "x")
	t = replaceAll(reEcho, t, "x")
	t = replaceAll(reERB, t, "")
	t = rePHP.ReplaceAllStringFunc(t, func(block string) string { // keep blocks that echo markup
		rest := block
		if len(rest) > 5 {
			rest = rest[5:]
		} else {
			rest = ""
		}
		if reTagStart.MatchString(rest) {
			return strings.NewReplacer(`\"`, ` "`, `\'`, ` '`).Replace(block)
		}
		return blank(block, "")
	})
	if reKyseExt.MatchString(ext) {
		t = replaceAll(reGoBlock, t, "") // the Go header of a Kyse template
		t = maskDirectives(t)
	}
	return t
}

// blankOutside returns text with everything outside [from, to) blanked.
func blankOutside(text string, from, to int) string {
	return blank(text[:from], "") + text[from:to] + blank(text[to:], "")
}

// locator maps byte offsets to 1-based line and column; the column counts
// UTF-16 code units, as editors do.
type locator struct {
	text   string
	starts []int
}

func newLocator(text string) *locator {
	starts := []int{0}
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			starts = append(starts, i+1)
		}
	}
	return &locator{text: text, starts: starts}
}

func (l *locator) at(offset int) (line, column int) {
	i := sort.Search(len(l.starts), func(i int) bool { return l.starts[i] > offset }) - 1
	if i < 0 {
		i = 0
	}
	if offset > len(l.text) {
		offset = len(l.text)
	}
	col := 0
	for _, r := range l.text[l.starts[i]:offset] {
		col += len(utf16.Encode([]rune{r}))
	}
	return i + 1, col + 1
}

// node is an element of the light tree.
type node struct {
	tag      string
	attrs    []attr
	parent   *node
	children []*node
	offset   int
	// rawStart and rawEnd delimit the text content of script, style,
	// textarea and title elements; rawEnd is 0 when the element has none.
	rawStart, rawEnd int
	hasRaw           bool
}

type attr struct {
	name        string
	value       string
	hasValue    bool
	offset      int
	valueOffset int
}

// readBraced reads a templ `{ expr }` value starting at i (the opening brace)
// and returns the end offset.
func readBraced(text string, i int) int {
	depth := 0
	var quote byte
	for j := i; j < len(text); j++ {
		ch := text[j]
		if quote != 0 {
			if ch == '\\' && quote != '`' {
				j++
			} else if ch == quote {
				quote = 0
			}
			continue
		}
		switch ch {
		case '"', '\'', '`':
			quote = ch
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return j + 1
			}
		}
	}
	return len(text)
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

var (
	reCloseName = regexp.MustCompile(`^</([A-Za-z][^\s>/]*)`)
	reOpenName  = regexp.MustCompile(`^<([A-Za-z][A-Za-z0-9:_.-]*)`)
)

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func isNameStop(c byte) bool { return isSpace(c) || c == '=' || c == '/' || c == '>' }

// parseMarkup tokenizes the (already masked) markup and returns the tree.
func parseMarkup(text string) *node {
	root := &node{tag: "#root"}
	current := root
	i := 0
	n := len(text)
	for i < n {
		rel := strings.IndexByte(text[i:], '<')
		if rel == -1 {
			break
		}
		lt := i + rel
		if strings.HasPrefix(text[lt:], "<!--") {
			end := strings.Index(text[lt+4:], "-->")
			if end == -1 {
				i = n
			} else {
				i = lt + 4 + end + 3
			}
			continue
		}
		if lt+1 < n && text[lt+1] == '/' {
			m := reCloseName.FindStringSubmatch(clip(text[lt:], 80))
			endRel := strings.IndexByte(text[lt:], '>')
			if m != nil {
				name := strings.ToLower(m[1])
				for nd := current; nd != nil && nd.parent != nil; nd = nd.parent {
					if nd.tag == name {
						current = nd.parent
						break
					}
				}
			}
			if endRel == -1 {
				i = n
			} else {
				i = lt + endRel + 1
			}
			continue
		}
		nm := reOpenName.FindStringSubmatch(clip(text[lt:], 80))
		if nm == nil || (lt+len(nm[0]) < n && !isSpace(text[lt+len(nm[0])]) && text[lt+len(nm[0])] != '/' && text[lt+len(nm[0])] != '>') {
			i = lt + 1
			continue
		}
		tag := strings.ToLower(nm[1])
		nd := &node{tag: tag, parent: current, offset: lt}
		p := lt + len(nm[0])
		selfClosed := false
		for p < n {
			ch := text[p]
			if ch == '>' {
				p++
				break
			}
			if isSpace(ch) {
				p++
				continue
			}
			if ch == '/' {
				if p+1 < n && text[p+1] == '>' {
					selfClosed = true
					p += 2
					break
				}
				p++
				continue
			}
			if ch == '<' && p+1 < n && (text[p+1] == '/' || text[p+1] == '!' || text[p+1] == '?' || text[p+1] >= 'A' && text[p+1] <= 'Z' || text[p+1] >= 'a' && text[p+1] <= 'z') {
				break // unterminated tag
			}
			if ch == '"' || ch == '\'' {
				cl := strings.IndexByte(text[p+1:], ch)
				if cl == -1 {
					p = n
				} else {
					p = p + 1 + cl + 1
				}
				continue
			}
			if ch == '{' {
				p = readBraced(text, p)
				continue
			}
			q := p
			for q < n && !isNameStop(text[q]) {
				q++
			}
			if q == p {
				p++
				continue
			}
			a := attr{name: text[p:q], offset: p, valueOffset: -1}
			p = q
			r := p
			for r < n && isSpace(text[r]) {
				r++
			}
			if r < n && text[r] == '=' {
				r++
				for r < n && isSpace(text[r]) {
					r++
				}
				a.hasValue = true
				a.valueOffset = r
				var vc byte
				if r < n {
					vc = text[r]
				}
				switch {
				case vc == '"' || vc == '\'':
					cl := strings.IndexByte(text[r+1:], vc)
					stop := n
					if cl != -1 {
						stop = r + 1 + cl
					}
					a.value = text[r+1 : stop]
					a.valueOffset = r + 1
					if cl == -1 {
						p = n
					} else {
						p = stop + 1
					}
				case vc == '{':
					stop := readBraced(text, r)
					a.value = text[r:stop]
					p = stop
				default:
					s := r
					for s < n && !isSpace(text[s]) && text[s] != '>' {
						s++
					}
					a.value = text[r:s]
					p = s
				}
			}
			nd.attrs = append(nd.attrs, a)
		}
		current.children = append(current.children, nd)
		if !selfClosed && !voidTags[tag] {
			if rawTextTags[tag] {
				closeRe := regexp.MustCompile(`(?i)</` + regexp.QuoteMeta(tag) + `\s*>`)
				loc := closeRe.FindStringIndex(text[p:])
				nd.rawStart, nd.hasRaw = p, true
				if loc != nil {
					nd.rawEnd = p + loc[0]
					p = p + loc[1]
				} else {
					nd.rawEnd = n
					p = n
				}
			} else {
				current = nd
			}
		}
		i = p
	}
	return root
}

// walk visits the descendants of nd in document order.
func walk(nd *node, visit func(*node)) {
	for _, c := range nd.children {
		visit(c)
		walk(c, visit)
	}
}

// ancestors lists the ancestors of nd, nearest first, without the root.
func ancestors(nd *node) []*node {
	var list []*node
	for p := nd.parent; p != nil && p.parent != nil; p = p.parent {
		list = append(list, p)
	}
	return list
}
