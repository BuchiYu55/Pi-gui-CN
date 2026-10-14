; 默认安装目录（2026-10-13 owner 反馈「希望用户选好位置后自动建 pi-gui 子目录」时的配套设计）
;
; 【自动子目录逻辑已原生存在，无需再造】assistedInstaller.nsh instFilesPre：开始拷文件前
;   StrContains 检查 $INSTDIR 不含 APP_FILENAME 则自动追加——用户选 E:\ 实际落在 E:\pi-gui\。
;   APP_FILENAME 取值（targetUtil.js:41）：产品名纯 ASCII 用原名，否则回落 sanitizedName；
;   本产品名「Pi 桌面版」含中文 → APP_FILENAME 恰为 "pi-gui"（package.json name 净化）。
;   注意该钩子只在 GUI 流程生效（静默 /S 不触发 MUI 页面回调）。
;
; 【本文件的实际作用】把「默认值」从 UserProgramFiles\Pi 桌面版 固定为 per-user 标准位置的
;   ASCII 子目录：① 免 UAC、卸载干净；② 纯 ASCII 安装路径——pi SDK 运行时 spawn bash/esbuild
;   子进程，含中文路径有转码风险；③ isUpdated 保护——静默更新不重置用户已选目录。
;   （owner 个人习惯装 E 盘不受影响：浏览自选目录 + instFilesPre 自动追加子目录两条都在）
!macro customInit
  ${ifNot} ${isUpdated}
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\pi-gui"
  ${endIf}
!macroend
