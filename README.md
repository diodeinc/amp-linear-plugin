# Amp Linear Plugin

A small Amp plugin for Linear issues, teams, projects, and comments.

## Install

Without cloning the repo:

```sh
mkdir -p ~/.config/amp/plugins
curl -fsSL https://raw.githubusercontent.com/diodeinc/amp-linear-plugin/main/linear.ts \
  -o ~/.config/amp/plugins/linear.ts
```

From a checkout:

```sh
mkdir -p ~/.config/amp/plugins
cp linear.ts ~/.config/amp/plugins/linear.ts
```

Then run `plugins: reload` in Amp.

## Configure

Run `Linear: Configure API key` in Amp, or set `LINEAR_API_KEY`.
