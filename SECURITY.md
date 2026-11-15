# Security policy

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security
problem. Report it privately to:

**TODO(author): security contact** (a private address or the repository's
private vulnerability reporting; to be defined by the author before the
repository is opened).

Include the YPY version, the browser, a minimal reproduction (markup and
server response) and the impact you see. Reports in English or Portuguese are
fine.

You can expect an acknowledgement and a first assessment from the maintainers;
we will keep you informed until the problem is fixed and will credit you in
the release notes if you wish.

## Supported versions

While YPY is below 1.0, only the latest release receives security fixes. From
1.0, the latest minor of the current major and the previous major's last minor
are supported.

## Scope

In scope: the core (`src/`), the official extensions, the build output in
`dist/`, the command-line tools and the Go SDK (`github.com/ypy-develop/go`).
Typical examples are script or HTML injection through responses or attributes,
bypass of the nonce gate, `selfRequestsOnly` or Trusted Types protections, CSP
violations in the default mode, and prototype pollution.

Out of scope: vulnerabilities in applications that use YPY without following
its documented guidance (for example, returning unescaped user input in HTML),
and issues that need a malicious browser extension or physical access.

## Secure defaults

YPY aims to be safe without configuration: no `eval` or `new Function` in the
default mode, strict-CSP compatible, and requests restricted to the same
origin unless configured otherwise. Opt-in features that weaken these defaults
are documented as such.
