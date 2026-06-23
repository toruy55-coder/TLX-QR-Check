# 眼鏡オーダーQR照合アプリ

オーダーメイド眼鏡の伝票QRと棚QRを、1つの共通読取欄またはカメラで照合する静的Webアプリです。

## 起動方法

```bash
python3 -m http.server 5174
```

ブラウザで `http://localhost:5174/` を開きます。

## 主な機能

- `qr_type` による伝票QR・棚QRの自動判定
- `check_item` による照合項目の自動判定
- フレーム品番、フレームカラー、レンズカラー、レンズカーブ、レンズ形状の照合
- OK / NG / エラーの色表示と音通知
- 全項目OK表示
- Bluetooth QRリーダー向けの入力欄フォーカス維持
- スマートフォンカメラでの連続読取
- 未完了注文中に別伝票QRを読んだ場合の切替確認
- 読取履歴表示

## サンプルQR

伝票QR:

```json
{"qr_type":"order","order_id":"ORD-000123","frame_model":"F-100","frame_color":"BK","lens_color":"GR","lens_curve":"4C","lens_shape":"ROUND"}
```

棚QR:

```json
{"qr_type":"shelf","check_item":"frame_model","value":"F-100","label":"F-100 フレーム棚"}
```

```json
{"qr_type":"shelf","check_item":"frame_color","value":"BK","label":"ブラック フレーム棚"}
```

```json
{"qr_type":"shelf","check_item":"lens_color","value":"GR","label":"グリーン レンズ棚"}
```

```json
{"qr_type":"shelf","check_item":"lens_curve","value":"4C","label":"4カーブ棚"}
```

```json
{"qr_type":"shelf","check_item":"lens_shape","value":"ROUND","label":"ラウンド形状棚"}
```

## 補足

カメラQR読取はブラウザ標準の `BarcodeDetector` API を利用しています。未対応ブラウザではBluetooth QRリーダーまたは手入力欄を使ってください。
