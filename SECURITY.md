# Security

`rx` runs on a developer's machine against that developer's own extension
checkouts. It reads files, runs `git`, `gh`, `npm` and `ray` through
`execFile` with argument arrays (never a shell), and talks to GitHub and npm
only inside the network boundary each command documents in
`docs/commands.md`.

Report a vulnerability privately through GitHub's "Report a vulnerability"
button on this repository, or by email to chris.messina@gmail.com. Please
include the `rx` version (`rx --version`), the command, and a reproduction.
You will get an acknowledgement within a week.

Things that are in scope: a command reading or writing outside its documented
state location; a forbidden-list scan that can be bypassed; `rx guard`
allowing a publish it should block; any way to make a command execute text
from an extension or a PR as code.

Out of scope: the behavior of `ray`, `gh`, `npm` or Raycast's Store review,
which `rx` only observes.
