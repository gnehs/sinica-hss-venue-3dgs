# 中央研究院人文社會科學館 · 3DGS 互動地圖

以 3D Gaussian Splatting（3DGS）掃描重建的中央研究院人文社會科學館互動地圖。掃描依樓層切開、補上樓板，再用異向性 Kuwahara 濾鏡渲染成順著結構走的油畫筆觸。點選議程廳時會載入該房間的高密度模型，並即時切除擋住視線的牆面與天花板。

- 完整版模型（建議用電腦開啟）：https://superspl.at/scene/5874982f
- 寶寶版模型（25%）：https://superspl.at/scene/21d99ba8

## 開發

```bash
pnpm install
pnpm dev
```

`pnpm test` 跑型別檢查，`pnpm build` 輸出靜態網站到 `dist/`。

## 部署

以 [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) 部署成純靜態資產的 Worker（`wrangler.jsonc` 只設定 `assets.directory`，沒有 Worker 程式碼）。在 Cloudflare 後台把 Worker 連到這個 repo，建置設定如下：

- Build command：`pnpm build`
- Deploy command：`npx wrangler deploy`（預設值）

網站掛在 https://sinica-hss.gnehs.net ，以 `wrangler.jsonc` 的 `routes` 設成 Custom Domain，部署時會自動建立 DNS 紀錄與憑證（`gnehs.net` 需在同一個 Cloudflare 帳號下）。網址同時寫在 `astro.config.mjs` 的 `site`，canonical、分享卡片與 sitemap 都由它產生。

本機手動部署則用 `pnpm run deploy`。

## 架構

- `src/pages/index.astro`：頁面與 UI（側欄地點選擇、資訊說明）
- `src/components/venue/venue-viewer.ts`：three.js + [Spark](https://sparkjs.dev) 的 splat 檢視器（樓層切換、房間模式、牆面切除、拾取）。畫面靜止時不重畫；手機載入 `lite/` 的輕量模型
- `src/components/venue/kuwahara-pass.ts`：畫風後處理（結構張量 + 異向性 Kuwahara + 調色與筆觸紋理）
- `src/components/venue/trees.ts`：建物周圍的程序化低多邊形樹，位置（`trees.json`）依空拍圖的樹林與草坪分佈產生
- `src/components/venue/floor-outlines.json`：各樓層樓板輪廓（掃描座標）
- `src/data/venue.json`：樓層與地點，`area` 為沿牆描出的多邊形
- `public/models/venue/*.sog`：依樓層裁切、以 [splat-transform](https://github.com/playcanvas/splat-transform) 壓縮的 SOG 檔；`rooms/` 為各房間的高密度模型，`lite/` 為手機用的輕量版，`floors/` 為樓板色圖

## 授權

程式碼以 [MIT](LICENSE) 授權釋出。

`public/models/` 內的 3D 模型與樓板色圖以 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授權釋出，使用時請標註由 [gnehs](https://gnehs.net/) 掃描製作。
