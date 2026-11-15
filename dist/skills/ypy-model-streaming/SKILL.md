---
name: ypy-model-streaming
description: Stream the answer of a language model into a page with YPY, formatted and safe. Use when the request is to "stream ChatGPT or LLM tokens to the page", "show the answer as it is written", "render Markdown while it arrives", "the Markdown jumps or flickers while streaming", "a Stop button for the generation", "model output is untrusted, prevent XSS or prompt injection in the answer", "announce the answer to a screen reader without reading every token", or when tokens are sent one event each. Covers the three-region recipe, the Go ModelStream and ypymd, the ypy-model extension (ypy-untrusted, ypy-follow, ypy-stop, announcements) and the stream options merge and frame.
license: MIT
---

# Streaming a model answer into fragments

A model writes a few bytes per token, tens of tokens per second. Do not send an event per token and do not
let the browser parse Markdown. The server batches, renders and sanitizes; the page receives HTML.

## The recipe (no new event, only `ypy-patch-elements`)

1. Patch an answer container into the page once:

   ```html
   <article id="a42" ypy-untrusted ypy-follow aria-live="off" aria-busy="true">
     <div id="a42-done"></div>   <!-- closed blocks: append only -->
     <div id="a42-tail"></div>   <!-- the open block: replaced on each flush -->
   </article>
   ```
2. Every flush (50 ms, a closed block, a size limit) sends, in one write, `append` to `#a42-done` with the blocks
   that closed and `inner` on `#a42-tail` with the open block. The cost is the open block, not the answer.
3. At the end send one `outer` of `#a42` with the whole final HTML, no `aria-busy`, and `data-ypy-answer="done"`
   (`"stopped"` or `"failed"` otherwise). That event repeats the state in full: a client that missed events or
   reconnected ends right.
4. Plain text (logs, code completion): the low-cost mode, one `append` of escaped text per flush.

## Server (Go SDK)

```go
ms, err := ypy.NewModelStream(s,
    ypy.WithModelTarget("#chat", ypy.ModeAppend), ypy.WithAnswerID("a42"),
    ypy.WithRenderer(ypymd.Renderer{}),           // Markdown by stable blocks, safe by construction
    ypy.WithAnnounce("Answer started", "Answer ready", "Answer stopped", "The answer failed"),
    ypy.WithFollow())
// pass ms.Context() to the provider request: Cancel, a stop and a dropped connection free the call
for tok := range tokens { ms.WriteString(tok) }
ms.Close()   // or ms.Cancel() after a Stop, ms.Fail() on a provider error
```

- The selector, mode and ids are constants of the server; model text only goes through the renderer.
- `ypymd` escapes raw HTML, drops images, allows `http`, `https`, `mailto` and relative links, and emits no `ypy-*`
  attribute. A Markdown renderer you plug in must follow the same allowlist (`ypymd` package comment).
- The user Stop records the stop with a normal request (`POST /generations/<id>/stop`, CSRF as any POST). The
  generation is bound to an id: **bound** (the connection ends the call, the default) or **detached** (the app keeps
  `ms.Text()` in its registry and a reconnect gets the snapshot).
- Cap bytes and events per answer, limit concurrent generations per user, and never log tokens by default.

## Client

```html
<script src="/ypy.max.js"></script>   <!-- or ext/ypy-stream.js and ext/ypy-model.js -->
<div id="gen" ypy-stream.post="/ask" ypy-config='{"stream":{"frame":true}}'>
  <button ypy-post="/generations/42/stop" ypy-swap="none" ypy-stop="#gen">Stop</button>
  <section id="chat"></section>
</div>
```

- `ypy-untrusted` on the container: what enters loses scripts, styles, forms, frames, svg, `ypy-*`, `on*`,
  `javascript:` and `data:` addresses and images (`ypy-untrusted="images"` keeps images). Defense in depth: the
  server renderer is the first wall.
- `stream.frame` applies events one animation frame apart; `stream.merge` (on) joins waiting patches of the same
  selector: the last `inner`/`outer` wins, `append` concatenates.
- Accessibility: the container is not a live region; `aria-busy` while written; one message at the start and one
  at the end (`ypy-announce-start`, `ypy-announce`, `ypy-announce-stop`, `ypy-announce-error`, or
  `config.announce.messages.answerStart|answerReady|answerStopped|answerFailed`). `config.announce.stream:
  "blocks"` opts in to each closed block. Focus never moves; `ypy-follow` scrolls only a reader at the bottom and
  never with `prefers-reduced-motion`. Keep the Stop button before the answer in the DOM, a real `button`.

## Do not

- Do not put `ypy-*` attributes, ids or selectors from model text on the wire. An injected `ypy-post` is an attack
  without a script.
- Do not send one event per token for formatted text, do not re-render the whole answer at each flush for long
  answers, and do not announce token by token.
- Do not let the browser talk to the provider (the key would leak).
