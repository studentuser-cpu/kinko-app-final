// server.js
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json()); // JSONリクエストを受け取る設定
app.use(express.static('public')); // publicフォルダ内のHTMLを表示する設定

// --- ここが「絶対にパクられない」隠された計算ロジック ---
app.post('/api/calculate', (req, res) => {
  const { inputs, config } = req.body;
  const prices = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1];
  
  let currentTotal = 0, needMoney = 0, availableMoney = 0;
  let results = {};

  prices.forEach(price => {
    const s = config.denoms[price];
    const barVal = Number(inputs[price]?.b || 0);
    const coinVal = Number(inputs[price]?.c || 0);

    // 行の合計金額計算
    let rowAmount = (s.bMode !== "none" || s.cMode !== "none") ? ((barVal * s.perBar) + coinVal) * price : 0;
    currentTotal += rowAmount;

    // 棒金(Bar)の判定ロジック
    let bText = "-", bClass = "";
    if (s.bMode !== "hidden" && s.bMode !== "none") {
      const dBar = barVal - s.tBar;
      bText = dBar > 0 ? "+" + dBar : (dBar < 0 ? dBar : "OK");
      bClass = dBar > 0 ? "txt-plus" : (dBar < 0 ? `txt-minus ${s.bMode}` : "txt-ok bg-ok");
      if (dBar > 0 && s.isAvailB) availableMoney += dBar * s.perBar * price;
      if (dBar < 0 && s.bMode === "bg-red") needMoney += Math.abs(dBar) * s.perBar * price;
    }

    // バラ(Coin)の判定ロジック
    let cText = "-", cClass = "";
    if (s.cMode !== "hidden" && s.cMode !== "none") {
      const dCoin = coinVal - s.tCoin;
      cText = dCoin > 0 ? "+" + dCoin : (dCoin < 0 ? dCoin : "OK");
      cClass = dCoin > 0 ? "txt-plus" : (dCoin < 0 ? `txt-minus ${s.cMode}` : "txt-ok bg-ok");
      if (dCoin > 0 && s.isAvailC) availableMoney += dCoin * price;
      if (dCoin < 0 && s.cMode === "bg-red") needMoney += Math.abs(dCoin) * price;
    }

    // 各金種の計算結果を格納
    results[price] = { rowAmount, bText, bClass, cText, cClass };
  });

  const diffVal = currentTotal - config.vaultTotal;

  // 計算結果だけをフロントエンドに返す（仕組みはバレない）
  res.json({
    currentTotal,
    diffVal,
    needMoney,
    availableMoney,
    results
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});