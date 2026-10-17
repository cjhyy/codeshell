# prep150：Root meta package 输出路径与声明合同

**有限0新正式问题、0候选、0new-related。** 亲读当前 root 配置、build-meta 声明输出及 core/TUI 目标包配置，未建立正常入口下的导出/bin/资源路径错位。未执行 build、import、helper、test、install、release、CLI、native、网络或Git。

Root提供冻结上下文 `c6a85ac1b69329f35bc1f6ff34d08070f91b1d96`；本人未读取Git。AGENTS/CODESHELL延用此前实际阅读并核同SHA。[初始pin](initial-pins.json)、[包pin](package-before-pins.json)、[config pin](config-before-pins.json)均在各自body/行号导航前。

## 当前普通链

- 根 `package.json#/scripts/build` 先列core/TUI等包的build，最后才运行 `scripts/build-meta.ts`；根依赖声明core和TUI workspace包。这里不推断安装/发布时workspace版本如何改写，也不保证build成功。
- 根 main、types、root exports 分别为 `dist/index.js` 与 `dist/index.d.ts`；build-meta26–27声明写同路径并 `export *` from core。core root exports也声明其 `dist/index.{js,d.ts}`。不是从当前dist存在性反推成功。
- 根bin指 `dist/cli.js`；script29–31声明带shebang的import `@cjhyy/code-shell-tui/cli`，TUI `exports./cli` 对应 `dist/cli/main.js`/声明文件。script35–38另声明旧 `dist/cli/main.js` launcher import `../cli.js`；保留旧链接合同而不保留过时bundle。正常参数、真实CLI控制没有运行。
- core/TUI scripts的正常构建入口是各自tsc配置。所读config声明 `rootDir=./src`、`outDir=./dist`、declaration与include规则；`src/index.ts`、`src/cli/main.ts`只核实际文件名存在。所列预期输出布局与exports一致，未读取/生成dist或验证编译器实际产物。
- meta脚本只声明清除/重建root dist和这些转发文件；root `/files`另显式列4个图像资源路径，它们目前文件名存在，见[资源库存](declared-resource-inventory.json)。没有读取二进制、渲染、打包tarball或完整资源依赖闭包；没有凭“脚本未copy根图像”推断资源丢失，因为这些资源是package files的直接声明。core/TUI copy-assets脚本值只作为当前build配置读到，不展开其它复制leaf。

## 旧范围与实际阅读

原R24 `root-package-prep/source-manifest#/sources/131`明确同SHA build-meta full static；R31 `entry-source-manifest#/files/11`也明确full1–38并保存before/finish。因此本轮38行全文为**旧全文重叠的定向配置合同复核**，不算新增唯一覆盖。R6 `/files/87`只有hash/selected inventory，本身不能作全文证明。当前任务保留上述实际传递链，没有为凑未读模块换leaf。详见[gate](gate-decision.json)与[canonical pins](canonical-before-pins.json)。

亲读旧R6 `root-package.md:1–26`仅核其原范围和测试边界。旧A11 release push/tag是范围排除，不重报；旧test:watch候选不作本批重新判定。旧报告17pass等为当时记录，没有打开/运行其fixture或日志，不能当本轮通过。

[源manifest](source-manifest.json)有6语义文件：3个全文文本文件合计94行（含旧build-meta38行）与3份selected JSON值文档，共32个原JSON pointers；JSON值格式化输出不伪算原文件逐行覆盖。另2指令hash、2入口和4资源仅文件名元数据。配置全文不等于编译器/native/权限或完整发布机制认证。[选段](source-excerpts.json)在实际显示后复制已读文本/原值，不执行。

## 历史、结束与收据

Root153[共享投影](shared-history-projection.json)为6126 MD/JSON、4322397递归JSON value scalars、0parse，含archive、排keys、纳冻59排60+。build-meta109命中，**cap100只保留前100**；不能把前100当全context审读。[原始path/SHA导航](targeted-history-navigation.json)另保留32份字节pin，仅用于定位原件，非第二次全历史semantic/cause扫描。

[首诊断](diagnostics.json)本轮无失败或tool截断；cap是检索保留限制而非tool错误。[结束核对](ending-checks.json)8个源/指令pins、5canonical+32原导航pins及共享batch全同字节；文件名存在性也保留。不据此认证全部6126成员、未来Git或真实发布包。[分类](classification.json)、[验证边界](validation.json)、[入口库存](declared-entry-inventory.json)、[冻结检查](freeze-checks.json)、[自排除receipt](reviewer-receipt.json)保留。
