const express = require('express');
const path = require('path');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// 【ここが重要！】publicフォルダの中にある index.html を表示する設定
app.use(express.static(path.join(__dirname, 'public')));

// あなたの金庫計算ロジック（例）
app.post('/calculate', (req, res) => {
    const data = req.body;
    // ここにあなたの「隠したい計算式」を書く
    const result = data.value * 1.1; // 例：10%増しにする
    res.json({ result: result });
});

// もしURLに直接アクセスが来たら index.html を返す設定
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000; // Render用のポート設定
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
