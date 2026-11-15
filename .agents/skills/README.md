# Skills

Procedures an assistant follows when working on the YPY framework.

They live in `.agents/skills/<name>/SKILL.md`, which is the path the coding
assistants read from: Cursor, Codex, Cline, Copilot, Gemini CLI, Amp, OpenCode,
Warp, Zed and the rest all look there. It is one directory rather than a file
per vendor, so a skill written once is read by whatever this project is being
written with.

Each file opens with frontmatter carrying a `name` and a `description`. The
description is what a tool reads to decide whether the skill is relevant, so it
names the situation you are in rather than the topic it covers.

| skill | when it fires |
| --- | --- |
| `ypy-core` | changing `src/ypy.js`: a new attribute, event, state, config key, or a size budget that is about to break |
| `ypy-extension` | writing or changing a file in `src/ext/`, its fragment in `src/attributes.d/`, or the list of extensions in `ypy.max` |
| `ypy-testing` | writing, placing or running a test, or a test that passes in `src/` and fails in `dist/` |
| `ypy-release` | before a push or a release: the `ypy ci` gates, the build, the sizes, a forbidden name, a failing gate |

The skills for people who **use** YPY in an application (`ypy-usage`,
`ypy-debugging`, `ypy-migrate`, `ypy-extensions`) are a different set. They live
in `src/skills/` and the build copies them to `dist/skills/`, so they travel
with the package.

## Why these exist

The audience of this directory is somebody changing the framework, not somebody
using it. The questions are different ones: where a line of the core goes, what
an extension may touch, where a test lives and what fails when a gate does.

A model asked to change a JavaScript framework fills the gaps with the ones it
knows: a build step, an `npm` script, a `package.json`, an inline `style`, an
`eval`, a compatibility switch for another library. None of those exist here.
The core is one file read by the browser, the tools are Go, and the gates fail
on every one of those guesses.

The rest of the answer is that the repository is built to be checked rather
than trusted. The size gate measures every file, `ypy gen --check` compares the
table of names with the code, `ypy test --dist` runs the suites against what
users load, and `ypy ci` runs all of it in one command. An assistant that runs
it is not guessing.

## Adding your own

A skill in this directory is yours and travels with the repository. Keep it a
procedure rather than a description: a file that says "read the documentation"
never changes what anybody does. Every command in one has to be a command that
runs, and every number in one has to be a number somebody measured.
