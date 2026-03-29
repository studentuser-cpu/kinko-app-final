const express = require('express');
const path = require('path');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// 1. まず「public」フォルダの中身を公開する設定
app.use(express.static(path.join(__dirname, 'public')));

// 2. あなたの計算ロジック（ここを自分の計算式に書き換えてください）
app.post('/api/calculate', (req, res) => {
    const data = req.body;
    // --- ここに秘密の計算式を書く ---
    const result = data.value * 1.1; // 例
    res.json({ result: result });
});

// 3. 【重要】どんなアクセスが来ても index.html を無理やり表示させる設定
app.get('*', (req, res) => {
    // フォルダ階層を自動で探して index.html を返します
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            // もし public/index.html が見つからない場合のエラー表示
            res.status(404).send("index.html が public フォルダの中に見当たりません。GitHubを確認してください！");
        }
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
