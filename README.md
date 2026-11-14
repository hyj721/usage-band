# usage-band

A private Claude Code mod that draws one band above the prompt. It merges two earlier mods: the usage band (forked from JetsonChan/CC-Usage-Band 1.0.6, MIT) and a local cache-timer.

## Install (instructions for an agent)

Follow these steps when asked to install this mod on a machine. Run them in a shell, not inside a Claude session.

1. Check the prerequisites. Claude Code must be 2.1.322 or newer (tested on 2.1.322 to 2.1.325).

   ```bash
   claude --version
   ```

   If `claude` is not found, try `~/.local/bin/claude`.

2. Find a git URL that can read this private repository; it belongs to the GitHub account `hyj721`. Try these in order and keep the first one that lists a `refs/heads/main` line.

   ```bash
   git ls-remote git@github-personal:hyj721/usage-band.git
   git ls-remote git@github.com:hyj721/usage-band.git
   git ls-remote https://github.com/hyj721/usage-band.git
   ```

   `github-personal` is the user's SSH host alias for the `hyj721` key in `~/.ssh/config`. If none of the three works, stop and ask the user to set up access for `hyj721`; do not ask for a token or create keys yourself.

3. Remove older copies of the mod, if any. These commands fail harmlessly when nothing is installed.

   ```bash
   claude plugin uninstall usage-band@cc-usage-band
   claude plugin uninstall usage-band@local-mods
   claude plugin uninstall cache-timer@local-mods
   ```

4. Add this repository as a marketplace, using the URL that worked in step 2, and install the mod from it.

   ```bash
   claude plugin marketplace add git@github-personal:hyj721/usage-band.git
   claude plugin install usage-band@usage-band
   ```

5. Verify. The first command must print an entry for `usage-band@usage-band`; the second must end with `Validation passed`.

   ```bash
   grep -A6 '"usage-band@usage-band"' ~/.claude/plugins/installed_plugins.json
   claude plugin validate ~/.claude/plugins/marketplaces/usage-band
   ```

6. Tell the user that running Claude sessions must be restarted (or `/reload-plugins`) before the band appears.

Do not change `statusLine` or any other setting in `~/.claude/settings.json` unless the user asks. A `statusLine` script can stay; it draws below the prompt and the band draws above it.

## Update

```bash
claude plugin marketplace update usage-band
claude plugin update usage-band@usage-band
```

## Uninstall

```bash
claude plugin uninstall usage-band@usage-band
claude plugin marketplace remove usage-band
```

## What it shows

The band shows four meters:

- **5h / 7d**: how much of the 5-hour and 7-day rate-limit windows is used, and when each resets
- **ctx**: tokens in the context window out of its size
- **cache**: the last turn's prompt-cache hit rate, and a countdown until the prompt cache expires

A meter turns red when it needs attention: a limit or the context past 80%, a hit rate under 50%, or under a minute of cache left. The cache meter turns amber in its last five minutes and gray once the cache is cold.

On the desktop app each meter is a pill whose background fills with its value; the cache pill drains as its lifetime runs out. The VS Code extension draws the same pills in a smaller size and wraps them in a narrow side bar. In the terminal the band is one line of text that drops detail to fit narrow windows.

## Commands

- `/cache-ttl` shows the cache timer; `/cache-ttl 5m` or `/cache-ttl 1h` sets the cache lifetime it counts against
- `/usage-band-preview` shows the terminal band in every icon style

Set `USAGE_BAND_ICONS` to `auto`, `nerd`, `unicode` or `ascii` to pick the terminal icons.

## Files

- `hooks/band.ts`: pure drawing code (formatting, the items, terminal spans, the desktop SVG)
- `hooks/register.tsx`: the hooks that collect readings and draw the band
- `types/index.d.ts`: the state contract

## Development

To change the mod, clone the repository and start Claude from the clone, which hot-reloads edits:

```bash
git clone git@github-personal:hyj721/usage-band.git
claude --plugin-dir ./usage-band
```

Before committing, bump `version` in `.claude-plugin/plugin.json` (an install only updates when the version changes) and run:

```bash
claude plugin validate .
claude plugin test .
```
