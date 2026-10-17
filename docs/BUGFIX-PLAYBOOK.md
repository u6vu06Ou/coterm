# Coterm Bug 修復 Playbook
> 衝突時以程式碼現況為準。

## 六步流程（每顆 bug 都走一遍，不跳步）

1. **重現**：寫下最短重現步驟。UI bug 用 dev 模式（npm run dev）+ 手動操作；API bug 用 curl 打 http://127.0.0.1:43127（token 在 <userData>/agent-api-token.txt）。無法穩定重現 → 先做步驟 2 蒐證，不准直接改 code。
2. **蒐證**：三個證據源，按序讀：a. <userData>/logs/coterm.log（JSON-lines，grep level=error/warn）b. <userData>/logs/crash.log c. 原始碼：用 grep 或程式碼索引工具找執行流，看目標 symbol 的 callers/callees。
3. **定位假設**：寫一句話的根因假設 + 指到具體檔案:行號。假設不能驗證 → 加暫時 log（logger.debug，修完移除）再重現一次取證。
4. **最小修**：只改根因，不順手重構。動 symbol 前先查清影響面（callers/callees）。
5. **驗證**：npm run verify 全綠 + 手動重現步驟確認消失 + 相鄰功能抽查（同檔案被改到的其他分支至少手測一條）。
6. **收尾**：移除暫時 log，回報 diff 摘要，等確認才 commit。

## 常見坑（歷史教訓）

- xterm 渲染類 bug（疊字、游標偏移、推擠）：先分清「資料重複」vs「顯示重複」——查 pty-manager scrollback 原始內容再看 renderer replay 路徑，別直接改 CSS。
- 跨裝置同步類 bug：主程序 dock-layout 是單一真相源；先確認 main 的狀態對不對，再查 WS broadcast 有沒有發、renderer store 有沒有收。三段各自驗證。
- 中文/編碼類：終端機顯示亂碼多半是 CP950 顯示假象；判斷要看原始 bytes。
- 修 UI 後一律在 desktop + web 兩端都驗（mobile 若相關也驗）。
