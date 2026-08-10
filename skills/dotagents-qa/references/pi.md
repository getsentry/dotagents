# Pi QA

Use this reference when plugin targets include `pi` or Pi discovery is part of a compatibility claim.

Pi reads shared `.agents/skills/` locations rather than a separate dotagents plugin marketplace. A Pi-targeted plugin therefore projects each valid plugin skill into `.agents/skills/<skill>` with a dotagents ownership marker.

Keep Pi in a separate fixture from OpenCode. OpenCode also reads `.agents/skills/`, so a combined fixture can make OpenCode appear to pass through Pi's projection.

File-level proof:

```bash
pi --version
find .agents/skills -maxdepth 1 -type l -print
for link in .agents/skills/<expected-skill>; do
  test -L "$link"
  test -f "$link/SKILL.md"
  test -f ".agents/skills/.dotagents-managed/$(basename "$link")"
done
```

For user scope, the corresponding links live in `$DOTAGENTS_HOME/skills/`.

Pi does not currently expose a no-auth command equivalent to `opencode debug skill`. File and symlink proof establishes projection only. Do not claim that Pi loaded or invoked a skill without an authenticated runtime interaction and a visible sentinel.
