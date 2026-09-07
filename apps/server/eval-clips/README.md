# Eval clips

Drop your own recordings here alongside a `labels.json` (see `labels.example.json`
for the shape), then:

```bash
npm run eval --workspace apps/server -- --clips apps/server/eval-clips
npm run eval --workspace apps/server -- --clips apps/server/eval-clips --model claude-sonnet-5
```

Each run calls the API once per clip, so a 30-clip set is 30 requests plus their
web searches. Start with `--limit 3` to check the wiring before spending on a
full run.

Clips in this directory are ignored by git: they are recordings of copyrighted
television, and they are yours, not the repository's.

## What to put in the set

Aim for 20 to 40 clips that look like real use, not best-case use:

- both capture modes, camera and screen recording
- dark scenes and bright ones, with and without dialogue
- at least a few episodes of long-running shows, which is where episode-level
  accuracy actually gets decided
- a couple of clips that *should* fail: a black screen, an advert, a home video.
  A model that never abstains is not calibrated, and the report will show it.

## Reading the report

- **accuracy** is correct answers out of every clip. This is the headline.
- **precision when it answers** ignores abstentions. A model can look accurate by
  refusing the hard clips; comparing these two shows whether it is doing that.
- **mean confidence when right against when wrong** is the number to check before
  turning on `FIRST_PASS_MODEL`. If the two are close, confidence cannot be used
  as an escalation threshold and the cascade will hand you wrong answers cheaply.
