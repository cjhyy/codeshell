# Prep104：细长图片缩放的独立静态反证

**支持同一线索的P3静态提案，不另建ID或重复计数。** Root后告知提案别名IMAGE-R103-C1、拟正式DESKTOP-R52-01；这是父任务上下文，未读取Root103包。已知线索后独立读源码，不称盲审；产品/图片/DOM/语言fixture、helper及测试运行均0。

## 正常触发与源原因

正常可解码、正尺寸 **1×4096** 的PNG/JPEG/WebP，文件在10MB和数量门槛内，选择low或standard。attachments62–68/96–155的普通File入口只限数量、MIME和bytes，生成dataUrl/size后直接返回accepted，没有长宽比或短边≥某值的过滤。它不是非法维度、NaN、任意伪造DTO或随机失败。

App1531–1535接受merged.images.detail的low/standard/high并在2660交给ChatView。ChatView1225–1242的实际local粘贴/选图/拖图路径先buildAttachments，再compressBatch(accepted,imageDetail)；1295–1302/1308–1334给出普通入口。compress.ts79–85/110–125使low/standard即使under2MB也会load/scale，所以“小图会直接pass”不能排除此条件；high/default的小图正常直通不在影响范围。

compress.ts189–199的短边仅Math.round，没有最小1pixel。人工源推导：low短边1×1024/4096=0.25→0；standard为0.3828125→0；长边仍1024/1568。横向4096×1走196行，对称得到0高度。没有调用函数、执行JS/Buffer算式、生成图片或冻结时钟实验。

118–133直接把结果赋给canvas.width/height。WHATWG HTML的[toBlob算法](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-toblob)步骤2–4.2（所读渲染行336–350）先以null初始化result，仅两边均非零才复制/序列化，最后用result回调；零边会保留null。135–152的质量梯级复用同一零bitmap，每次null只continue，最终返回原att；getContext为null或绘制异常的分支也保留原件。这是普通有效输入被算法生成无像素目标，不借随机reject/OOM当问题证据。

结果限定为：**Renderer未按所选档位缩小该细长图，并把未缩小的dataUrl/mime/name交到staging调用边界。** ChatView1251–1274使用compressed字段并更新正常staging元数据，反驳另一个“旧path残留”猜测；本提案没有那项。Host可能的进一步处理、最终wire、真实模型计费/token数量未认证；图片没有据此丢失，也不声称全部图片失败。建议缩放后的短边至少保留1pixel；本轮不修产品、不写或运行回归。

## 门槛、反证与范围

[初pin](initial-pins.json)在正文/行导航前固定compress218行/8303B、SHA05ca45452af16298d425059a174f5673b3c855ba481ea514c167af6206028f50。Root报告00e47e070…，本读者Git0。[fresh history](history.json)纳冻51排52+：5017=1479MD+3538JSON，2348391 strings/3489788 scalars，169精确archive/_archive，解析0；path66/SHA20/filename71/宽oldCause23，cap100均全保留，不等于全部语义读完。

实际读60对象定位、10条scope投影、1个[原canonical hash-only行](canonical-gate-read.json)及23个有界旧因窗。未建立当前sameSHA old-full；排名/unknown/hash不证明从未读。源名确定后对同一5017库存作[focused补查](focused-history.json)：scaledDimensions0、canvas与zero/round宽AND11、compress与细长/明确尺寸词0；11窗实际读完，均是别的browser/media/byte-probe文字，长MD分散词误命中不能当精确根因或语义穷尽证明。旧失败方向继续SKIP；[gate](gate-decision.json)/[实际选读](history-selected.json)保留限制。

现有compress.test.ts82行只读11个声明，含一般横竖/方图及rounding-tolerant案例、档位/alwaysDownsample合同；没有当前细长边界。未执行或借旧pass验证DOM；既有invalid-detail测试也不用作普通反例。

[manifest](source-manifest.json) **2 full +3 selected，449语义行=367产品+82测试声明；549正文显示、含导航567。** full是compress218和test82静态阅读，其它消费者仅所列普通数据范围；必要App/ChatView旧读可能重叠，不作首次/全史唯一覆盖或全局coverage更新。路径/身份、claim/cwd/会话、Host资源/安装与provider机制止于调用/相邻显示边界。

[消费者pin](consumer-initial-pins.json)/[detail初pin](clarity-initial-pins.json)先于相应body/nav；[显示pin](source-display-pins.json)、[导航](producer-navigation.json)、[detail导航](clarity-navigation.json)与[后捕获摘录](source-excerpts.json)分开。WHATWG仅官方文档web阅读3调用，精确URL/步骤及中文转述另存[标准记录](external-standard.json)，不是产品网络或DOM实验，不假称存了完整网页/网页SHA。

## 诊断与冻结

[首诊断](first-reader-diagnostic.json)保留metadata presenter9954/8500、后补4527/4500截断（均exit0），仅把受影响保存窗分批补读；另有自有Python转义SyntaxWarning/exit0，未妨碍pin或导航。[finalizer首诊断](finalizer-first-diagnostic.json)保留自有audit脚本括号SyntaxError/exit1，解析前停止；修正仅完成metadata归档，无新增产品语义/运行重试。原完整stdout/stdin未另存的边界照实保留，不把再生数据当raw。

[Ending](ending-checks.json)7个源码/指令pin全同，原5017历史集合与bytes无漂移。指令同SHA沿用94阅读，不重复算产品行。产品/helper/import/fixture/test/React/DOM/timer/native/model/Git、真实用户图片/设置与业务网络执行0；仅自有metadata处理、rg导航和明确官方文档读取。没有修改产品/旧冻件，详见[validation](validation.json)与[receipt](reviewer-receipt.json)。
