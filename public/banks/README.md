# 银行 logo（M13-12）

账户卡片、流水、筛选、导入页的银行方块（`BankMark`）先看这个目录：有对应的图片就显示图片，没有就显示字母方块。

## 文件名

文件名就是账户的 `bank` 值，后缀 `.svg`、`.png` 或 `.jpg`（小写，`.jpeg` 不认）。同一个 `bank` 有几种时按 svg → png → jpg 用第一个。

| `bank` | 文件 | 没有图片时 |
| --- | --- | --- |
| `anz` | `anz.svg` / `.png` / `.jpg` | 蓝底 ANZ |
| `anz_plus` | `anz_plus.svg` / `.png` / `.jpg` | 深蓝底 ANZ+ |
| `cba` | `cba.svg` / `.png` / `.jpg` | 黄底 CBA |
| `cash` | `cash.svg` / `.png` / `.jpg` | 绿底钞票图标 |
| `other` | `other.svg` / `.png` / `.jpg` | 灰底银行图标 |
| `westpac` | `westpac.svg` / `.png` / `.jpg` | 红底 W（M9.5-7 加枚举后生效） |
| `boq` | `boq.svg` / `.png` / `.jpg` | 深紫底 BOQ（M9.5-7 加枚举后生效） |
| `ing` | `ing.svg` / `.png` / `.jpg` | 橙底 ING（M9.6 加枚举后生效） |

`anz` 和 `anz_plus` 是两个文件，只放 `anz.svg` 不会影响 ANZ Plus 账户。

## 图片要求

- 正方形，64×64 以上（显示是 20px 和 32px，高分屏要两倍以上），128×128 左右就够
- jpg 没有透明底，小图边缘也容易糊，能用 svg 或 png 就别用 jpg
- 图片会缩放到方块里（`object-contain`），四周留白自己控制
- 暗色模式下底色不变，透明底的深色 logo 在暗色模式下可能看不清，最好自带底色

## 说明

- logo 是各银行的商标，图片自己找、自己放，代码不生成
- 图片提交 git，这样 Vercel 上也能显示
- 服务端读这个目录（`src/server/bank-marks.ts`）：本地 `pnpm dev` 刷新页面就能看到，线上要重新部署
