---
"@paddock/server": minor
---

Surface the posture profile on the Config screen (#878). A read-only **Posture
profile** row heads the Advanced group, and every setting the profile actually
chose is marked with a `profile` chip — so `Instructions: host` is now
self-explanatory rather than something you have to go and derive from a YAML
file.

The chip is attribution, not decoration: the server only reports a field as the
profile's when neither an env var nor an explicit key in `paddock.config.yaml`
set it. A `PADDOCK_CLAUDE_*` override keeps its existing `env` chip and gets no
`profile` chip, even where the two happen to agree — crediting the profile for a
value the environment set would tell an operator the opposite of the truth about
what their instance shares.

Read-only for the same reason the five `claude.*` rows beside it are: those
symlinks are planted at agent-registration time, so a live toggle would silently
do nothing until the next restart — and a writable profile row would set exactly
those five keys at once.
