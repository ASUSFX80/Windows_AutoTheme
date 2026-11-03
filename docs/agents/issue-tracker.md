# Issue tracker: GitHub

本项目的问题和规格记录在 ASUSFX80/Windows_AutoTheme 的 GitHub Issues。
使用 gh CLI，所有操作显式指定 --repo ASUSFX80/Windows_AutoTheme。

- 读取：gh issue view <number> --repo ASUSFX80/Windows_AutoTheme --json number,title,body,labels,comments
- 列出：gh issue list --repo ASUSFX80/Windows_AutoTheme --state open
- 创建：gh issue create --repo ASUSFX80/Windows_AutoTheme --title "..." --body-file <file>
- 评论：gh issue comment <number> --repo ASUSFX80/Windows_AutoTheme --body-file <file>
- 标签：gh issue edit <number> --repo ASUSFX80/Windows_AutoTheme --add-label "..." 或 --remove-label "..."
- 关闭：先发表评论说明原因，再执行 gh issue close <number> --repo ASUSFX80/Windows_AutoTheme。

多行正文写入临时文件，通过 --body-file 传入。
技能要求“发布到 issue tracker”时，创建 GitHub issue。
读取上游问题时使用完整链接；新问题默认创建在本 fork。

## Pull requests as a triage surface

**PRs as a request surface: no.**
