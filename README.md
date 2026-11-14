# 中央研究院人文社會科學館 · 3DGS 互動地圖

用 3D Gaussian Splatting（3DGS）掃描重建的中央研究院人文社會科學館互動地圖。可以切換樓層、點選議程廳走進房間，畫面以油畫筆觸風格呈現。

網站：https://sinica-hss.gnehs.net

- 完整版模型（建議用電腦開啟）：https://superspl.at/scene/5874982f
- 寶寶版模型（25%）：https://superspl.at/scene/21d99ba8

## 開發

```bash
pnpm install
pnpm dev
```

## 授權

程式碼以 [MIT](LICENSE) 授權釋出。

`public/models/` 內的 3D 模型與樓板色圖以 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授權釋出，使用時請標註由 [gnehs](https://gnehs.net/) 掃描製作。
