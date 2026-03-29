const express = require('express');
const cors = require('cors');
const path = require('path'); // ← これを追加
const app = express();

app.use(cors());
app.use(express.json());

// 👇 これが重要！「publicフォルダの中身を公開する」という命令
app.use(express.static(path.join(__dirname, 'public'))); 

// ...あとの計算ロジックなどはそのまま...

// 最後にポートの設定（Render用）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
