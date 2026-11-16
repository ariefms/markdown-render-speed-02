# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ariefms/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ariefms/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free JavaScript Markdown renderer. `parse.js` exports `parse(markdown)`, which returns exactly the HTML that marked 18.1.3 renders with its default options (GFM on, breaks off) — byte for byte on the CommonMark 0.31.2 and GFM 0.29 spec examples plus generated README documents. `main.ts` is the harness driver: it reads `/input/cases.json`, renders each case alone with `parse`, and writes `/output/html.json`.

## Run it

```sh
node main.ts
```

Reads `cases.json` from `MAKEFUN_INPUT_DIR` (default `/input`) and writes `html.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=gpdw47pd&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
