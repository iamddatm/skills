---
name: dotnet-production-debug
description: |
  用户排查生产环境 .NET 程序故障时调用:CPU 飙高/忙循环、内存上涨/OOM/泄漏(托管堆/非托管/句柄)、内存碎片(LOH/Pin)、死锁/卡死/Hang/线程池饥饿/线程爆高、程序崩溃、GC 异常(Gen2 频繁/停顿长/终结队列积压)、Dump 抓取与分析(windbg/PerfView/DotMemory/dotnet-dump analyze)、Linux/容器排障、无症状 dump 体检(潜在问题扫描)。
  关键 trigger:CPU 爆高/打满、内存暴涨/泄漏、卡死/挂死/死锁、崩溃/crash、OOM、线程池饥饿、LOH 碎片、dump 怎么抓、windbg、!syncblk、!dumpheap、!gcroot、dotnet-dump、perfcollect、Finalizer 积压、分析这个 dump/看看有没有潜在问题/体检。
  不适用于:纯代码风格问题、SQL 数据库自身性能调优、架构设计咨询、.NET 语言特性学习、无故障的预防性监控体系设计(本 skill 强于事后取证,弱于事前监控)。
tags: [dotnet, debugging, performance, dump, windbg, gc, memory-leak, deadlock, linux]
related_skills: []
---

# .NET 生产环境性能故障排查

## 方法论骨架

本 skill 汇总大量 .NET 生产故障排查实战经验,稳定方法论如下:

1. **症状驱动路由**:先问"用户看到了什么"(CPU/内存/响应性/存活四元组),再选路线。不从"先抓 dump 再说"出发。
2. **先定性再定量**:用轻量工具把问题分流到 托管堆 / NTHeap / VirtualAlloc / Loader 堆 / 句柄 / 线程栈 / 内核池 七条支线之一,不同支线工具与修复完全不同。
3. **双快照 Diff**:内存问题永远采"正常时段 + 异常时段"两份快照比增量。大缓存程序单快照"污水混净水",什么都看不出。
4. **大 dump 避险**:>10G 的 dump 是灾难(分发慢、单条 sos 命令数小时)。先 VMMap 定性,再用 PerfView 把大 dump 压成 <1M 的 gcdump 做 Diff。
5. **证据链原则**:不信描述只信数据;结论必须落到第二手证据(汇编/gcroot/syncblock/句柄表);嫌疑要用第二个工具"再卜一卦"佐证。
6. **从轻到重分级投入**:活体轻量观测(DotTrace Sampling/DotMemory 快照)→ 采样 → dump → windbg 深挖。生产采 dump 优先 PerfView 附加(开销最小)。
7. **版本/平台敏感**:同一现象在 .NET Framework / Core / .NET 8 根因可能完全不同;Windows 与 Linux 工具生态"各自为政"。
8. **外部因素排除**:查不出时怀疑杀毒软件、辐射 bit 翻转、安全软件注入、CLR/框架自身 bug——"不是我们代码造成的,查代码不可能找出问题"。
9. **降层原则**:应用层 dump 查不出的偶发超时,降到 TCP 层看 wireshark;托管层查不出的内存,降到 NTHeap/malloc 层。

**详细工具表、命令速查、异常代码表、根因全目录、术语词典见同目录 [INDEX.md](./INDEX.md)。**

---

## 典型应用案例

每场景一个代表案例(更多见 INDEX.md §6 根因目录):

### 案例 1 (CPU):bgc 蝴蝶效应
- **问题**:64 核机 CPU 59% 偶发几十秒,`!t -special` 找不到 SuspendEE。
- **方法论使用**:三段排除法走到 GC 分支时没有放弃——bgc(后台 GC)与工作线程并发,本就没有 SuspendEE 标记;`~*k` 非托管栈见 21 线程在 `backgroundgc SetFree`,bgc 线程数 == 核数。
- **结论**:4 个业务请求全量捞 10w+ 条数据造海量临时对象,把 64 个 bgc 线程拖成 CPU 密集。
- **结果**:修掉未过滤的 UI 参数,爆高消失。

### 案例 2 (内存):静态缓存灌入"污水"
- **问题**:平时 4G 的缓存程序涨到 6G,大 dump 无法硬分析。
- **方法论使用**:VMMap 定性为托管泄漏 → 正常 4G/异常 6G 两份 dump → PerfView `Take Heap Snapshot From Dump` 压成两个 <1M gcdump → `Diff -> With Baseline`。
- **结论**:增长的 2G 全被 `_staticCache` 静态 List 吃掉,一目了然。
- **结果**:业务增加释放时机。

### 案例 3 (碎片):ReloadOnChange 万恶之源
- **问题**:内存 8.7G 但对象统计没有大类型;`!dumpheap -stat` 中 Free 占大头、FileSystemWatcher 1290 个。
- **方法论使用**:Free 最大 → 碎片;单段 `!dumpheap <begin> <end>` 见 Free 与 8216 字节 byte[] 三明治交替;`!gcroot` 夹层 byte[] → `async pinned handle → OverlappedData → AsyncReadState.Buffer`;钻到 `<ReloadOnChange>k__BackingField=1`。
- **结论**:循环内反复 `AddJsonFile(..., reloadOnChange: true).Build()`,每次 new 的 watcher 把 8KB 读缓冲异步 pin 死。
- **结果**:Configuration 构建一次复用。

### 案例 4 (Hang):Task.Result 海枯石烂
- **问题**:WinForm 点按钮后界面永久卡死,同样代码在 Console 不死锁。
- **方法论使用**:`~0s; !clrstack` UI 线程卡 `Task.Result→Monitor.ObjWait`;`!gcroot` 引用链出现 `Queue + MoveNextRunner`——延续 Task 已被 `WindowsFormsSynchronizationContext.Post` 入 UI 队列等主线程执行。
- **结论**:主线程死等延续 Task 完成,延续 Task 死等主线程执行,互相等到天荒地老。
- **结果**:`ConfigureAwait(false)` + 调用侧改 await。

### 案例 5 (崩溃):宇宙射线
- **问题**:托管堆损坏,`!verifyheap` bad member,但 `dp` 现场内存无任何破坏花样。
- **方法论使用**:坏 MethodTable 与正确 mt 仅差 1-3 bit;`!dumpheap -mt <正确mt>` 能找到"差一位"的真实对象;`.formats` 二进制比对;排除 GC_MARKED bit0 正常置位。
- **结论**:单 bit 翻转 + 现场无破坏花样 = 辐射/硬件,不是软件。
- **结果**:ECC 内存、远离辐射源(高铁伺服电机旁)。

### 案例 6 (Hang·静默型):异步积压——体征全正常,计数悄悄涨
- **问题**:ASP.NET Core 6 Web API(Linux 容器,16 核),平时无明显症状,仅偶发下游调用失败。dump 体征全正常:CPU 1-2%、工作线程全空闲、syncblk 零锁竞争、GC 堆仅 122MB——传统 Hang 工具箱(锁表/线程栈/!runaway)全部失效。
- **方法论使用**:
  1. **双取第一动作**救场:全线程栈干净(异步的活不占线程),`dumpasync` 却挖出 169 个在途请求全在 await 下游;
  2. **跨类型比例法**(E9 第 4 步):9,044 个 HttpClient、2,437 个类型化 API 代理(WebApiClient),远超活跃操作基线(~150-330 个状态机);
  3. **gcroot 抽样判生死**:等距 16 样 14 个有根 → 不是未回收垃圾而是真持有;路径收敛于"Polly Bulkhead 异步链 → WebApiClient 代理 → HttpClient"(穿过 epoll 注册表/TimerQueue 链表的路径按铁律 3 排除,315 个 TimerQueueTimer 实为在途定时器链表串联,不是泄漏);
  4. **双快照二次取证**(9.5 小时后):流量降 46%,HttpClient 反涨 61%、代理 +63%、连接 +98%、`BulkheadRejectedException` 7→143(持续饱和)→ 逆流量增长 = 单调积累实锤;期间 CacheEntry 74,091→50,800 不涨反降,TTL 淘汰有效,顺手洗清缓存嫌疑。
  5. **回源码核实根因(纠正方向的关键一步)**:仅凭 dump 会倾向"bulkhead 无界队列 + 无超时"的假设,读代码后**被推翻**——本仓库 bulkhead 全部 `BulkheadAsync(N, 0)`(零队列宽度,超量立即拒绝,根本不排队),超时是 60s `HttpClient.Timeout`(有,但长)。真实机制是"长超时钉死槽位 + 无 CancellationToken 取消传导",不是"队列积压"。这正是铁律 4 的由来。
- **结论**:下游 API 慢/挂 → bulkhead 并发槽被 60s `HttpClient.Timeout` 全部钉死,新调用立即被拒(`BulkheadRejectedException`)+ 无 CT 传导(客户端断开后上游调用不取消)→ 每笔在途请求钉 60 秒,其持有的 HttpClient/代理/连接持续积累(净增 ≈580 客户端/小时)。
- **结果**:业务侧决定不改 60s 超时,改做两件事:① 热点路径加**超时熔断器**(谓词只认 `InnerException is TimeoutException` 的 `TaskCanceledException`,避免把客户端断开的取消误判为失败而误熔断,见 E5-H"熔断×CT 落地注记");② `HttpContext.RequestAborted` 端到端穿透 `ExecuteAsync`/`SendAsync`,客户端一断立即释放槽位。

---

## 触发场景 ★

### 用户会在什么情境下需要这个 skill?

1. 生产 .NET 程序 CPU 打满/偶发飙高,想知道抓什么、用什么命令、怎么定位到代码行。
2. 内存持续上涨/OOM,分不清是托管泄漏、非托管泄漏、句柄泄漏还是碎片。
3. 程序卡死/挂死/无响应,拿到 dump 不知从何看起。
4. 程序崩溃,有/没有 dump,想知道异常代码怎么分支、怎么防二次破坏现场。
5. GC 太频繁/停顿太长/内存降不下去,怀疑 GC 配置或终结器问题。
6. Linux/容器里的 .NET 出问题,Windows 那套工具不知道怎么搬。
7. 需要决定"抓 Full 还是 Mini、用 procdump 还是 WER、windbg 还是 PerfView"。
8. 没有明显症状:想给一份 dump(或活进程)做全面体检,扫描潜在隐患。

### 语言信号(用户话里出现就应激活)

- "CPU 100%/爆高/打满/偶发飙高"
- "内存暴涨/下不去/泄漏/OOM/虚拟地址不足"
- "卡死/挂死/Hang/无响应/死锁/线程池饥饿/线程数爆高"
- "崩溃/crash/闪退/异常退出/退出码 139"
- "dump 怎么抓/怎么分析/windbg 命令/sos"
- "GC 频繁/FullGC/停顿/Fragmentation/LOH/碎片"
- "!syncblk/!dumpheap/!gcroot/!eeheap/!analyze"
- "分析这个 dump/看看有没有潜在问题/体检一下/拿到 dump 不知从何看起"

### 与相邻领域的区分

- 与 **SQL 数据库调优**:本 skill 只管"数据库客户端侧的 .NET 进程表现"(连接池耗尽、慢 SQL 拖死线程池);SQL Server/MySQL 自身的索引/执行计划优化不是本 skill。
- 与 **代码审查/风格建议**:本 skill 输出的是取证路线与根因判据,不是"这段代码写得好不好"。
- 与 **监控体系设计**:本 skill 强于事后取证,弱于事前监控(EventCounters/OpenTelemetry 经验未覆盖)——用户要"搭监控"时如实说明。

---

## 可执行步骤

skill 被激活后,按以下步骤执行:

### E0. 四条铁律(任何场景先声明)

1. **不信描述只信数据**:用户/运维的归因常把你带偏,一切以 dump/计数器为准。
2. **先定性再深挖**:没确定"涨的是哪一块/卡的是哪族线程"之前,不许深入单点。
3. **嫌疑要二次取证**:dump 里看到的"明显根因"可能只是伴生现象(如 Task.Result 队列堆积常是卡死症状而非 CPU 元凶),用第二个工具/第二份 dump 佐证。gcroot 路径穿过全局共享结构(epoll 注册表/TimerQueue 内部链表/DI 中间件单例)时只是"某条可达路径",不是真归因,必须用计数互校或双快照复核(见 INDEX §3 gcroot 实战二注)。
4. **根因必须回源码核实**:dump 取证只能给出现象与方向;"缺失 X / Y 无界 / 没设超时"这类根因假设,落地整改前必须回源码核实——代码常常已显式处理(案例 6:dump 误判"bulkhead 无界队列 + 无超时",读代码才知是"零队列宽度 + 60s 长超时钉槽位 + 无取消传导")。拿不到源码时,结论只能写到"现象 + 方向",不得写成定论。

**三道 🔴 检查点(强制暂停等用户确认,禁止跳过)**:

1. 🔴 CHECKPOINT · 路线确认:E1 表判定路线后,先告知用户"将走 EX 路线、依据是什么",再开始执行;体检场景必须先与用户确认诉求,再决定是否跑全流程(E9 第 0 步)。
2. 🔴 CHECKPOINT · 根因核实:把根因结论写进报告前,对照铁律 4 自查——回过源码没有?拿不到源码时只能写"现象 + 方向",禁止写定论。
3. 🔴 CHECKPOINT · 整改评审:给出整改建议前,确认二次取证(铁律 3)与源码核实(铁律 4)已完成;涉及改代码时按 E5-H"熔断 × CT 落地注记"办理,用户确认前不得动生产代码。

### E1. 症状路由(先回答这张表)

| 用户主诉 | 30 秒定性动作 | 路由到 |
|---|---|---|
| CPU 高/打满 | 任务管理器确认持续 vs 偶发;持续→手工 dump,偶发→procdump 埋伏 | E2 |
| 内存涨/OOM | 任务管理器四列:**Private Bytes**(别看工作集)/句柄数/GDI 对象/线程数 | E3(涨)或 E4(涨但对象统计对不上) |
| 卡死/无响应 | 能否复现?能→抓 hang dump;Console 标题栏有"选择"→QuickEdit 回车即恢复 | E5 |
| 崩溃/退出 | 有 dump→直接分析;没有→先配自动抓取再复现 | E6 |
| GC 怀疑(卡顿+内存+CPU 混合) | PerfView GCStats 或 `!eeheap -gc` 确认 GC 占比 | E7 |
| Linux/容器 | 环境确认:`cat /proc/<pid>/maps`、`dotnet --info` | E8 |
| 混合型(CPU+内存+卡死三高) | 按"先卡死后内存最后 CPU"顺序排查,卡死常是因、CPU 常是果 | E5 优先 |
| 无症状/拿到 dump/要体检 | 30 秒分诊三问判定性(崩溃/挂/正常,见 E9 第 0 步),再确认诉求选路线 | E9 |

---

### E2. CPU 飙高

**决策路径**:

```
第 0 步 持续 vs 偶发
  偶发/瞬高 → procdump 阈值埋伏(禁止手工蹲守):
    procdump -ma -s 5 -n 2 -c 70 <进程名或pid> <dump目录>
    抓 2-3 份:① 两份做线程时间差推最耗时线程 ② 防抓到"活已干完 CPU 未回落"的无效时机
  持续高 → 任务管理器/手工抓 dump

第 1 步 定量(windbg 加载 dump)
  !tp     → CPU utilization 确认真高;Running==Total 且 Idle:0 = 计算密集
            ⚠ Work Request in Queue 堆积是【卡死症状】,不是 CPU 元凶,必须甄别
            ⚠ 异步服务端(ASP.NET Core 等)的活不在 CPU 线程上:Idle 全闲 + CPU 低 ≠ 没事,
              可能在途请求大量等 IO(dumpasync 看在途数,见 E9);"CPU 不高但系统卡"转 E5-H 分支
  !cpuid  → 核数(Linux dump 无此命令:!eeheap -gc 看 server GC 堆数 == 核数)

第 2 步 三段排除(按序,经验惯性顺序)
  A. 锁? !syncblk
     MonitorHeld 大、大量线程等同种锁 → lock convoy
     (MonitorHeld = 持有+1、每个等待+2;偶数 ≈ 抓到锁交接时间差)
     !syncblk 没料 → !mlocks 查 thinlock(某线程上千个 → ConcurrentDictionary 内部锁数组)
  B. GC?(经验上 GC 诱因远多于字面死循环,优先查)
     !t -special 找 (GC)/SuspendEE 标记;或 dp clr!SVR::gc_heap::gc_started L1 = 1
     全栈搜角色:WaitUntilGCComplete(受害者)/try_allocate_more_space(祸首)/gc_thread_stub(GC本体)
     三形态:
       ① SuspendEE 可见型 → !clrstack -a 找祸首分配的大对象(!da -details 看 Size>85000 即 LOH)
       ② 32bit lowmem 型 → GcCondemnedGeneration=2 连续 FullGC + !address 地址逼近 4G → 改 64bit
       ③ bgc 隐蔽型 → !t -special 无 SuspendEE,~*k 见 backgroundgc SetFree,线程数==核数
          → 谁在猛丢临时对象(一次捞 10w 条 foreach 造对象,4 线程打爆 64 核)
  C. 热点线程/忙循环(锁、GC 都排除后)
     !runaway 按 User Mode Time 排行,两份 dump 对比增量找 top
     ~Ns; !clrstack 切线程看栈;无用户代码 → !dumpstack/kb 看非托管栈
     定位后:!clrstack -a 挖参数 → !do 看对象规模(List._size/String._stringLength)
     定罪:!ip2md + !savemodule 导出模块 → ILSpy 反编译

判据 单核高 = 单线程忙循环;全核高 = 核数个线程合谋(或 server GC/bgc 线程群)
```

**根因八成落在四大族**:GC 压力(大对象/32bit/bgc)/ lock convoy / 伪死循环 / 第三方 SDK。

| 伪死循环家族 | 栈上特征 |
|---|---|
| 非线程安全 Dictionary 成环 | 25+ 线程同卡 `FindEntry`(Framework;Core 6+ 会抛异常而非死循环) |
| Task.Delay 未 await | `Task.Delay` 后直接回循环体,2 核机 2 线程打满 |
| 数据父子互指成环 | while 遍历部门树,`!mdt -e:2` 导出见两项 DeptId 互指 |
| O(N²) 算法 | `List.Insert(0)` 倒序 23w 行 / ForEach 内 FirstOrDefault |
| LINQ 谓词昂贵 | Where lambda 内逐项 DES 解密,LINQ 不做常量外提 |

**反模式(Top 8)**:
1. string += 海量拼接(大串 >85k 直上 LOH)→ StringBuilder
2. `ConcurrentDictionary.Values` 全量拉取(内部 1024 次 Monitor.Enter + new 等量 List 上 LOH)→ lock+Dictionary 或条件下推
3. `Task.Delay` 当 `Thread.Sleep` 用不 await → 弄清语义
4. 多线程共享非线程安全 Dictionary → 线程安全集合
5. Session_Start 上百个 `Application[x]=`(每次赋值一把锁 → convoy)→ 挪 Application_Start
6. 单次批量提交几万条(20M SQL 吃满正则替换)→ 5000 条/批
7. 400+ 线程 `Thread.Sleep(1)` 轮询(上下文切换风暴)→ 减线程、间隔 50ms+
8. 偶发爆高手工蹲守 → procdump 阈值埋伏

**平台差异**:Windows 现场用 Process Explorer 的 **Cycles Delta** 列;Linux 用 `perfcollect`(先 `export COMPlus_PerfMapEnabled=1`)采 trace.zip 拷回 Windows **仍用 PerfView 打开**——采集在 Linux,分析回 PerfView。容器内无人值守:`procdump -c 20 -n 2 -s 5 -w dotnet /dumps`。

**版本差异**:Dictionary 并发损坏在 Framework 下 FindEntry 死循环、.NET 6+ 遍历 entries.Length 次后强制抛 `InvalidOperationException`;线程池实现以 .NET 6 为界(C++ → C# PortableThreadPool);AOT 无 coreclr 模块,`!cpuid`/线程池字段挖掘方式都变。

---

### E3. 内存上涨 / OOM / 泄漏

**决策路径**:

```
第 0 步 真假泄漏
  忽高忽低、GC 后回落 → 大集合突发/扩容虚占(dump 中线程常卡 Dictionary.Resize/List.Insert)
  单调上涨不回头 → 真泄漏,继续
  只有单份 dump、拿不到两个时段 → gcroot 抽样判生死 + 跨类型比例法(E9 第 4-5 步),先答"泄漏还是垃圾"

第 1 步 任务管理器/Process Explorer 四列
  Private Bytes(别看工作集!泄漏内存会被换页,只有 PB = WS Private + Pages Out 看得到全貌)
  句柄数 或 GDI 对象涨 → 句柄分支;线程数异常 → 线程栈分支

第 2 步 分层定性(活进程先 VMMap,开销最小别急着抓 dump;有 dump 用 windbg)
  !address -summary + !eeheap -gc 对比
  (Linux dump:!address 失效;!maddress -summary 仅 windbg≥1.2402 可用,dotnet-dump analyze 不支持,
   此时托管侧靠 eeheap -gc + dumpheap -stat + gchandles 定性,命令对照见 INDEX §3.1)
  ├ PB 涨 且 GC Heap 同步涨 ─────► 托管分支
  ├ PB 涨 而 GC Heap 不涨 ────────► 非托管分支
  ├ !eeheap -loader Total 巨大 ───► 程序集泄漏
  ├ Stack 区域数×栈大小占大头 ────► 线程栈分支
  └ 机器内存涨但找不到进程 ───────► 内核模式池分支

托管分支(找根:谁持有?)
  !dumpheap -stat(-min 10240 过滤大对象)→ 锁定类型 → !dumpheap -mt <MT> → !gcroot <addr>
  辅助:!objsize(对象树总大小)、!da -details(解剖数组)、!dumpdelegate(委托来自哪个方法)
  !gcroot 报 0 roots(刚分配的局部对象)→ s-q 全堆搜引用 → !lno 上翻找持有集合
    → 反搜持有者地址落在线程栈 → dqs <栈址> L-50 → !ip2md 解析方法
  GUI 捷径:DotMemory 双快照 Diff 看 Retained Size 路径图,"从最深路径下手最快"

非托管分支(找根:谁分配的?)
  !heap -s 找 Commit 最大堆 → !heap -stat -h <handle> 按 size 分组 → !heap -flt s <size> → dc 看内容
  ⚠ 分配栈必须事前开 UST(gflags /i xxx.exe +ust),事后 dump 拿不到!
  开了 UST:!heap -p -a <block> 打分配栈 → !ip2md 把 native 帧翻成托管方法
  !heap -s 总和与内存对不上 → 盯 >512K 块:!heap <handle> -m 列 VirtualAllocdBlocks
  活进程非侵入:PerfView 勾 VirtualAlloc ETW 提供者看分配栈

句柄分支
  NT 句柄(Event/File):!handle 定性 → 活进程 !htrace -enable → g → !htrace -diff 拿分配栈
    非侵入:PerfView /KernelEvents:Handle → Windows Handle Ref Count Stacks
  GDI 句柄(用户态表,无 !htrace):GDIView 分类 → bm gdi32!*Bitmap* 断点 "k; gc" 缩圈
    纯 dump:dt ntdll!_PEB GdiSharedHandleTable → s-w 按 pid 搜 GDICell
    ⚠ 32bit 程序 PEB 表为 NULL,必须抓 Wow64 dump(procdump -64 -ma)

x86/32bit 特判(先于一切泄漏分析)
  !address -summary %ofTotal 逼近上限 → 2G 虚拟地址耗尽,未必是泄漏
  未设 LargeAddressAware 限 2G(设了吃 4G);OOM 也可能表现为 LOH 要不到连续大块
  修复:editbin /largeaddressaware 或 PE 头置 0x20 位;根治改 x64

超大内存程序(dump >10G,"污水混净水")
  弃硬开 windbg → VMMap 定性(若 NTHeap 此刻必须开 UST)
  → 正常/异常时段各抓 1 个 dump(PerfView 附加,开销比 DotMemory 小)
  → PerfView Take Heap Snapshot From Dump 压成 <1M gcdump → Diff - With Baseline
```

**根因目录(16 类摘要)**:静态集合无界增长 / 事件订阅未解除 / 缓存与自制池无上限 / 终结器积压(含 STA+COM 卡死 finalizer) / P/Invoke 未释放 / GDI 句柄泄漏 / NT 句柄泄漏 / 程序集泄漏(XmlSerializer 带 rootName、ProxyGenerator 非 static、Roslyn) / 大集合突发 / 字符串 intern 膨胀 / 线程爆炸吃栈 / 内核模式池 / 安全软件注入 / 框架 bug(DI EventSource 只增不清、3.1.20 CompositeChangeToken 死锁) / x86 2G 耗尽 / LOH 碎片。完整证据链见 INDEX.md §6。

**反模式(Top 10)**:
1. `reloadOnChange: true` + 轮询自建 FileSystemWatcher(句柄/内存/碎片/线程四罪)→ 只用框架自带且谨慎开
2. `new XmlSerializer(type, new XmlRootAttribute(rootName))` 不缓存(每次生成动态程序集,业界著名大坑)→ 缓存或用无 rootName 版本
3. Castle `ProxyGenerator` 每次 new → 改 static
4. 自制对象池只有 PUSH/POP 无上限裁剪 → ObjectPool/ArrayPool
5. 业务线程开 STA + 用 COM(finalizer 跨套间卡死,对象积压 7w+)→ 去 STA
6. 一次性读 10w+ 行进内存(千万级临时对象冲爆 LOH)→ 分批/DataReader
7. 32bit 不设 LargeAddressAware → 设标记吃 4G 或 x64
8. DI 生命周期误用(Singleton/Transient 不分 → 疯狂建线程,Stack 176GB)→ 遵循官方指引
9. 被 `!dumpheap` 的 free 碎片先入为主(真因可能是 static 堆积引发碎片)→ 先看引用链实占
10. NTHeap 泄漏事后才想起开 UST → VMMap 一判定就开

**平台差异**:Windows 有 VMMap/Process Explorer/GDIView/UST 全套;Linux dump 上 `!address` 失效,`!maddress -summary` 仅 windbg≥1.2402 可用(dotnet-dump analyze 无任何内存视图命令,对照见 INDEX §3.1);线程栈默认 **8M 实占**(Windows 1-1.5M,`DOTNET_DefaultStackSize=180000` 可调);非托管泄漏走 heaptrack/perf(见 E8)。

**版本差异**:x86 AnyCPU 在 64 位系统可吃 4G;32bit 进程 GDI 表必须 Wow64 dump;.NET Core 3.1.20 CompositeChangeToken 死锁(3.1.32 修);.NET 7 `EnableWriteXorExecute` 使 Linux Image 双映射暴涨(能禁就禁);.NET 8/10 Server GC 黑洞(.NET 10 默认 DATAS 缓解);DI EventSource 弱引用泄漏 .NET 10 修复。

---

### E4. 内存碎片(LOH / Pinned / GC Heap Fragmentation)

**决策路径**:

```
入口 内存居高不下但"没有哪个类型占用特别大",或 OOM 但活对象没多少

1. 定界:!address -summary vs !eeheap -gc 大致相当 → 托管层
2. 分流(关键):!dumpheap -stat 看末尾 Free 行
   Free 是"最大对象"(如 Free 7.3G/堆 13.3G)→ 碎片,继续
   Free 不大、String/Byte[] 居前 → 转 E3 泄漏/暴涨路径
   旁证:PerfView GCStats 的 LOH Frag %;DotMemory Heap Fragmentation(total ≫ used)
3. 实锤:从 !eeheap -gc 段表取单段地址,!dumpheap <begin> <end>
   Free 与 Live 呈交替/三明治状 → 碎片实锤(Free 无法合并 = 中间夹着活对象)
4. 追夹层存活物:!gcroot <夹住的活对象>
   链顶 async pinned handle→OverlappedData→Byte[]
     → FileSystemWatcher 8KB 缓冲被 pin → 查 ReloadOnChange
     (条件反射:Free 大 + FileSystemWatcher 实例数巨大 = reloadOnChange)
   链顶业务对象(Logger→Sink→Queue)→ 队列积压夹住 Free → 修下游
   ⚠ pin 句柄数正常也可能是碎片:长寿命对象散落同样夹住 Free,别被"碎片必因 pin"误导
5. WinDbg 盲区(看不出 Free 生前是什么):
   → PerfView Gen 2 Object Deaths Stacks(记录 LOH 已死对象的生前分配栈)
   → 再不行 Harmony 注入:Hook GCHandle.Alloc(Pinned) 或 FileSystemWatcher 构造函数记调用栈
6. 修复:应急 GCSettings.LargeObjectHeapCompactionMode=CompactOnce; GC.Collect()(LOH 一次性压缩)
   根治:关 reloadOnChange / GCHandle.Free() 配对 / 消除"一大一小交替释放"分配模式(池化)
```

**根因**:FileSystemWatcher 异步 pin(ReloadOnChange 经典款与非经典款)/ GCHandle.Alloc(Pinned) 不 Free / 长寿命对象积压夹 Free / LOH 大对象交替分配释放 / 大文件 byte[]↔string 转换堆爆 LOH(暴涨而非碎片)。

**反模式(Top 5)**:
1. 循环内反复 `new ConfigurationBuilder().AddJsonFile(..., reloadOnChange: true).Build()`(10w 次吃 2.2G)→ 构建一次全生命周期复用
2. 把 Framework 时代"每次重读配置"习惯套到 .NET Core → 理解 ReloadOnChange 副作用
3. `GCHandle.Alloc(obj, Pinned)` 不 Free(50k pin × 1000 轮 → 1.77G 只装 50M 对象)→ try/finally Free
4. LOH 上"一大一小"交替分配释放偶数项(Free 与 Live 严格交替永不可合并)→ ArrayPool 复用
5. 日志队列"名义有界实际无界"(积压 395w 条夹出 7.3G 碎片)→ 上限真实生效 + 溢出丢弃

**平台/版本差异**:FileSystemWatcher→OverlappedData→async pin 是 **Windows 特有链路**(ReadDirectoryChangesW),Linux(inotify)侧形态经验未覆盖。.NET 8 的 SOH segment 为 4M(region 模型);`!eeheap -gc` 中 .NET 5+ 可见独立 Pinned Object Heap 段。

---

### E5. 死锁 / Hang / 线程池饥饿 / 线程爆高

**决策路径**:

```
第 0 步 伪卡死三查(30 秒,避免白忙)
  ① !peb BeingDebugged: Yes + 主线程卡 WaitSuspendEventsHelper → 调试器挂着(VS/dnspy),不是生产故障
  ② Console 标题栏出现"选择" → conhost QuickEdit 冻结输出,回车即恢复
  ③ 线程栈卡在杀毒模块 → 停杀软复现(劫持 ResumeThread / 拖住 GC STW)

第 1 步 抓 hang dump → 全线程栈 + dumpasync 双取(永远的第一动作)
  ~*e !clrstack(dotnet-dump analyze 下换 clrstack -all,命令对照见 INDEX §3.1)
  dumpasync 列在途请求数/await 卡点分布/中间件链
  ⚠ 异步服务端(ASP.NET Core)卡死时工作线程可能全闲,现场全在 Task 图里——只看线程栈会一无所获

第 2 步 按栈帧特征分流:
  A. 大量卡 Monitor.ReliableEnter → 锁等待,!syncblk 看持有线程(MonitorHeld=1+等待×2):
     持有线程也卡 ReliableEnter → 双锁/三角死锁(!dso 看各线程想进的锁,与 Owning 交叉成环)
     持有线程卡 Control.Invoke → "锁内 Invoke UI,UI 又等这把锁"
     持有线程卡 IO(recv/sqlite3_step)→ 锁内慢 IO 无限期持有
     持有线程"消失了"(!t 查无此 ID)→ C++ 侧杀托管线程致锁泄漏(按 AwareLock 手工恢复)
  B. 大量卡 Monitor.ObjWait→Task.SpinThenBlockingWait → Task.Result 同步等异步,两形态:
     B1 UI 线程自己卡此栈(栈底 RunMessageLoop)→ SynchronizationContext 死锁(WinForm/WPF/MVC)
     B2 成百上千 Worker 卡此栈 → 线程池饥饿,!tp: Running==Total、Idle:0、队列积压
  C. 卡 Control.Invoke + UI 线程栈底 OnUserPreferenceChanged
     → 非 UI 线程创建过控件(无消息泵,系统广播 Send 永等)——偶发、远程桌面连接触发
  D. UI 线程卡同步 IO/业务(Socket.Connect/sqlite3_step)→ UI 线程干重活
  E. 线程数爆高(!t ThreadCount 成百~数万),看线程"长什么样":
     栈底 TimerQueueTimer + 卡锁 → Timer 回调阻塞,下周期又借线程进来排队
     大量 Thread.Sleep 在"超时监视"函数 → Sleep 轮询占满线程池
     ~*e .ttime 线程固定周期新增 → 周期调度 + 失败被吞,不断派线程赴死
     大量 Completion Port 线程卡 ReadDirectoryChangesW → FileSystemWatcher 泄漏回调风暴
  F. 主线程卡 ThreadStore::WaitForOtherThreads → 前台线程阻塞退出(!t State 列无 0x200)
  G. 卡在其他锁原语:
     ReaderWriterLockSlim.TryEnterReadLock → !do 锁对象看 _writeLockOwnerId,!t 找写锁持有线程(写锁内慢 IO 是常见根因)
     SpinWait(SpinLock/自定义自旋)→ SpinLock 无重入保护,同线程递归进入立即死锁、长持有锁死所有等待者(现有经验无专案例,取证参照 Monitor 线 + 全线程栈比对自旋方与持有方)
  H. 工作线程全闲、!syncblk 干净、!tp 也正常,服务却无响应 → 静默型异步积压:
     dumpasync 在途数 ≫ 常态;跨类型比例法(代理/HttpClient/连接/状态机数 vs 在途活跃数,见 E9 第 4 步)
     持有量超活跃量一个数量级 = 未完成操作积压
     常见形态:下游慢/挂 + 长 HttpClient.Timeout 钉死并发槽 + 无 CancellationToken 传导(客户端断开不取消)
     ⚠ 别默认"队列无界/没超时":bulkhead 是否排队、超时多长,必须读源码确认(铁律 4;案例 6 的 dump 曾误判"无界队列",读代码才知是零队列宽度 + 60s 长超时)

第 3 步 间歇卡顿(非死卡)→ 性能路线:
  dotTrace timeline:UI Freeze>200ms 计数、GCWait 占比(GC 频繁)vs Dispatcher 占比(UI 更新过频)
  锁竞争高频未死锁 → dotnet-trace contention 事件量化排队时间(跨平台,nettrace 回 PerfView)
```

**熔断 × CancellationToken 落地注记(整改陷阱,案例 6 实测)**:

给积压路径加"超时熔断 + CT 传导"时,若熔断谓词写成 `.Handle<TaskCanceledException>()`,**客户端断开产生的取消也会被算成失败**,可能误熔断。必须把谓词收窄到只认真正的超时。异常类型对照:

| 触发源 | 抛出的异常 |
|---|---|
| `HttpClient.Timeout` 到期 | `TaskCanceledException`(内嵌 `TimeoutException`) |
| 外部 CT(如 `RequestAborted`)取消 | `OperationCanceledException`(无 TimeoutException 内嵌) |
| Polly `TimeoutAsync` | `TimeoutRejectedException` |

正确写法:`.Handle<TaskCanceledException>(ex => ex.InnerException is TimeoutException)`。CT 穿透须端到端:`ExecuteAsync(async (ct) => …, cancellationToken)` → `SendAsync(req, ct)`,中间断一环即失效。另注意:CT 能否触发取决于反向代理是否传导断连(nginx `proxy_ignore_client_abort` 须为 off),上线前实测"客户端主动断开"验证。

**反模式(Top 12)**:
1. `Task.Result/.Wait()` 同步等异步(有上下文→死锁;无上下文→饥饿)→ 全链路 await;库代码 ConfigureAwait(false)
2. 锁内做 IO/Invoke/触发事件回调(锁持有期=IO 耗时;回调反要调用方的锁)→ 出锁后再 IO/回调
3. 锁粒度过大 → 缩临界区;并行聚合用线程局部结果+最后合并
4. 线程池线程 Sleep 轮询做超时 → CancellationTokenSource.CancelAfter 异步超时
5. Timer 回调慢于间隔(回调阻塞→线程线性堆积)→ 回调快进快出/"上轮未完跳过"闸门
6. 非 UI 线程创建控件(祸根在 dump 中无法回溯)→ 一切控件 Invoke 回 UI;bp MarshalingControl..ctor 溯源
7. UI 线程干重活 → Task.Run,UI 只更新
8. 双检锁单例里做重初始化(网络/.Result)→ 静态构造/Lazy
9. SemaphoreSlim WaitAsync 不在 try 里(漏 Release 永久 -1,且不记持有线程极难查)→ try/finally
10. 滥用 `ThreadPool.SetMinThreads` 提注入(ioCompletion 上限 1000 静默失败;秒建万线程崩 32bit)→ 治本异步化
11. SpinLock 递归进入/长持有(无重入保护,递归即死锁,长持有锁死全体等待者)→ 可能重入的场景用 lock;SpinLock 只用于极短临界区
12. 长超时钉槽位 + 无取消传导(下游慢/挂,长 HttpClient.Timeout 钉死并发槽;无 CT 传导,客户端断开后上游调用不停;悬挂操作每笔钉死代理/客户端/连接,线程全闲但计数持续涨,案例 6)→ 超时熔断器(谓词只认超时)+ CT 端到端穿透;先读代码确认队列/超时实况再开方(铁律 4)

**平台差异**:抓 dump:Windows 任务管理器/procdump,Linux `dotnet-dump collect`;sos 命令两平台通用;`!tp` 队列积压数可能 sos bug 失真(需 `!ext tpq` 手工 dump workItems);锁竞争量化用 dotnet-trace contention(跨平台)或 PerfView ContentionKeyword(Windows);非托管临界区 `!cs`、内核态观察仅 Windows 侧经验。

**版本差异(重点)**:
- 线程注入速率:Framework GateThread ~1s 注入 1 个;.NET Core+ `Task.Result` 触发 `NotifyThreadBlocked` 主动唤醒,阈值 250ms(~4 个/s),`AppContext.SetData("System.Threading.ThreadPool.Blocking.MaxDelayMs", 100)` 可到 7-8 个/s——只能缓解,上游太猛照样积压。
- **.NET 8 异步回调两次 Enqueue 放大饥饿**:IO 完成事件→高优先级队列→Worker 拆包再入线程本地队列→又一个 Worker 回用户代码;.NET 6 是 IO 线程一撸到底。综合性能 .NET 8 更强,但 1% 饥饿敏感场景不如 .NET 6 简单粗暴。
- SynchronizationContext:Framework WinForm/WPF/MVC 有(死锁温床);asp.net core 已移除(仍可能饥饿)。
- 调试钩子:`AppContext.SetSwitch("System.Threading.ThreadPool.DebugBreakOnWorkerStarvation", true)` 在饥饿第一现场 Debugger.Break()。

---

### E6. Dump 抓取与崩溃分析

**决策路径**:

```
A. 抓取路线
   按症状选类型:
     崩溃 → Full(-ma)      内存膨胀 → Full 按内存阈值(-m 1024)
     CPU 高 → 2+ 份差分(Mini 可)  GUI 挂死 → Full 按窗口(-h,web 慢请求抓不到)
   Windows 三级递进(procdump -e 抓不到就升级):
     ① procdump -e -ma -w <进程> <dir>      # 主动监控,进程退太快可能抓不到
     ② procdump -ma -i <dir>                # 注册 AeDebug 事后调试器(写注册表,常驻)
     ③ WER LocalDumps 注册表                # 最稳"万无一失":DumpFolder/DumpCount/DumpType=2(Full)
     任务管理器右键亦可:⚠ 抓 32 位程序必须用 SysWOW64\taskmgr.exe
   抓不到兜底:页堆(gflags -i <exe> +hpa,越界第一现场)/ MDA 跨边界立即 GC / TTD 录像倒查
   Linux/容器 → 见 E8

B. 分析路线
   环境三要素(不匹配则命令全废):
     ① windbg 位数 == dump 位数
     ② Framework: .load 框架目录 sos.dll + clr.dll
        Core 3.0+: dotnet tool install -g dotnet-sos; dotnet-sos install; .load ~/.dotnet/sos/sos.dll + coreclr.dll
     ③ 符号:SRV*C:\mysymbols*http://msdl.microsoft.com/download/symbols
   !analyze -v → 按 ExceptionCode 分支:
     c00000fd 栈溢出 → .excr;k 看递归模式(!teb StackBase/StackLimit 验证哨兵页机制)
     c0000005 访问违例 → 看崩溃函数:
        GC 标记帧(mark_object_simple/find_first_object)→ 堆损坏法医学(下)
        地址 0 → 空引用(JIT 插入的 this 检查);极大/极小地址 → 坏指针/bit 翻转
        第三方 native 模块 → 归属问题(升级 SDK)
     c0000374 NT 堆损坏 → !heap -s 看 Error type(HEAP_FAILURE_BLOCK_NOT_BUSY = Double Free)
     c0000409 栈 cookie → uf 验算 cookie;验算完好仍崩 → 怀疑 OS/硬件
     E0434352(.NET5+ 为 E0434F4D)托管异常 → !t Exception 列 → !pe -nested 异常链(HResult 8007000e=OOM)
     80000003 int3 → 抓 dump 冻结的软 trap,99% 正常,转 !t 找真异常
   堆损坏法医学:
     !verifyheap → dp <坏对象>-0x80 L20 看现场花样(C++ 数组花样=越界;单 bit 差异=辐射)
     ⚠ !verifyheap 报 No corruption 不可信(移动对象未固定/bgc 阶段问题不报)
     ⚠ mt 的 bit0 置 1 是 GC_MARKED 正常标记,勿判损坏
     找僵死线程:ScanStackRoots 首参与 !t ThreadOBJ 匹配;s-d 在 TEB 栈范围搜坏地址
   定罪:!name2ee *!命名空间.类.方法 → !savemodule <地址> x.dll → ILSpy
        混淆代码 !dumpil + !U /d;启动即崩 → TTD 录像 g- 倒流
```

**反模式(Top 8)**:
1. 指望全局异常处理包治崩溃(native 异常托管层接不住)→ AeDebug/WER 抓 dump
2. 全局异常处理器里再抛异常(弹窗初始化又抛→异常链逃逸崩)→ 处理器内只做最简记录
3. PInvoke 共享句柄无锁(Double Free → c0000374)→ 加锁+缩小作用域
4. 托管对象指针直接交 C++ 不固定(GC 移走→野指针)→ GCHandle.Alloc 固定
5. C++ TerminateThread 杀线程(GC 爬已死线程栈崩溃)→ 协作式取消
6. 32 位 windbg 分析 64 位 dump / sos 版本不匹配 → 三要素对齐
7. WER 只配 Mini dump 分析托管堆 → DumpType=2 Full
8. 用户态异常一律归因软件(可能是辐射/硬件)→ bit 级证据指向硬件时上 ECC 查环境

---

### E7. GC 行为异常

**决策路径**:

```
症状四选一:GC 太频繁 CPU 高 / 停顿过长卡顿 / 内存降不下去 / Finalizer 线程忙

第 1 步 确认是不是 GC 问题
  PerfView Memory→GCStats:% CPU Time spent GC、% Time paused、GC CPU MSec/MB Alloc
  windbg:!eeheap -gc(各代/LOH/Allocated vs Committed)、!eeversion(模式)
  GC 模式无侵入确认:PerfView 截 Runtime/Start ETW 的 StartupFlags(0x1=concurrent,0x1000=server)
  dump 内:x coreclr!GCConfig* 读 s_ConcurrentGC/s_ServerGC

第 2 步 五线分流
  ① 分配速率过高 → GC/Start 事件 Reason=AllocSmall + Open Any Stacks 找分配源
     (windbg 备选:bp coreclr!WKS::GCHeap::GarbageCollectGeneration + k 看 trigger_gc_for_alloc)
  ② Gen2 频繁/LOH 压力 → 对象 ≥85000 字节直进 LOH;gc_mechanisms condemned_generation=2
  ③ 停顿过长 → GCStats Pause>200ms 列表;归因:GCScanRoots(爬栈慢)vs relocate_phase(pin/碎片)
     !t -special SuspendEE = 全程冻结;确认后台 GC 已把全程暂停拆成两个小暂停
  ④ 终结队列积压 → !fq 看 Ready for finalization N objects → !t 找 (Finalizer) 线程
     ~~[osid]s; !clrstack 看卡在哪个慢操作;ETW FinalizerObject 事件间隔 = 单次析构耗时
  ⑤ 内存降不下去(非泄漏)→ !dumpgen 2 -free -stat 碎片占比;Allocated ≪ Committed = Server GC 黑洞

Server GC 内存黑洞:Committed 16.6G / Allocated 852M,每核一个囤积堆
  → <ServerGarbageCollection>false 改 Workstation / "System.GC.HeapCount": 2 / 大对象拆批次

GC.Collect 的边界:默认不用(打乱内部算法节奏);
  仅"启动灌入海量数据 + !dumpgen 量化碎片占比 ≥25%"这类确定性场景才用
```

**反模式(Top 5)**:
1. 到处 GC.Collect → 量化碎片占比后再决定
2. 到处 `x = null` 期望提前回收(.NET5+ 双栈位 null 无效;行为随 JIT 漂移)→ 缩短变量作用域
3. 给纯托管对象加 finalizer(至少两次 GC 才能回收 + 占唯一 Finalizer 线程)→ 只有真持非托管资源才写
4. finalizer 里做慢操作(单线程串行,积压数十万"死对象带着子对象存活")→ Dispose + SuppressFinalize
5. Dispose 后忘 SuppressFinalize(二次清理同一资源)→ Dispose 模式末尾固定写

**平台差异**:本部分经验全部来自 Windows 侧实践(windbg + PerfView ETW + DotMemory);`!eeheap -gc`/`!fq`/`!gcroot` 等 sos 命令在 Linux dump 理论可用但无实证——**经验未覆盖**,Linux 侧用 dotnet-dump analyze 同名命令。

**版本差异**:null 赋值回收行为 .NET5(Debug/Release 双栈位均无效)vs Framework 4.5(Debug 有效/Release 激进回收);后台 GC 三阶段(初始 STW→并发标记+Windows 脏页监控→最终 STW);GC 配置入口 csproj/runtimeconfig 为 SDK 风格,Framework app.config 写法经验未覆盖。

---

### E8. Linux / 容器环境

**决策路径**:

```
A. 崩溃抓 dump(三路线)
  ① createdump 环境变量(首选,Dockerfile 构建期写入):
     ENV COMPlus_DbgEnableMiniDump=1
     ENV COMPlus_DbgMiniDumpType=4          # 4 = full dump
     ENV COMPlus_DbgMiniDumpName=/dumps/%p-%e-%h-%t.dmp
     容器三铁律:docker run --privileged(否则报无权限)+ -v 宿主机目录:/dumps(否则容器退出 dump 丢失)
  ② 程序自主 dump(不愿常驻监控进程):
     new DiagnosticsClient(pid).WriteDump(DumpType.Full, "/data/x.dmp")  # EventPipe,底层仍是 createdump
  ③ procdump for Linux 旁挂:procdump -c 20 -n 2 -s 5 -w dotnet /dumps
  ⚠ 不要用 ulimit -c 抓托管崩溃:core 拷回 Windows 不自动加载 sos、托管函数名全 Unknown
  分析:dotnet-dump analyze <dump>(免配 sos,命令少)/ 拷回 Windows windbg(手工 .load)/ 活体 gdbserver + WinDbg≥1.2402

  业务帧解析两层论(Windows 分析 Linux dump 时的 !Unknown 根因,实测):
    ① 类型/方法名 ← DLL 元数据(程序集本体,不是 PDB!);② 源码文件/行号 ← PDB
    框架程序集由 dotnet-dump 自动从微软符号服务器下载,私有 app DLL 无服务器可下;
    _NT_SYMBOL_PATH 指本地目录对【元数据查找】不透(只喂 PDB 层),别在这条路上耗时间
    正解:dump 记录的模块是容器内路径(/publish/*.dll),DAC 按原路径回退查找,
    Windows 上 POSIX 路径落到当前盘根目录 → 把【与 dump 同构建】的产物(DLL+PDB)
    平铺进 <当前盘>:\publish\,名字立即解析(实测 unknown_type 939→0)
    ⚠ 必须同构建:sos 对不上 PE 标识宁可不解析;拿错版本喂进去会归因到错误代码行,比不解析更糟

B. CPU 爆高
  export COMPlus_PerfMapEnabled=1           # JIT 符号写 /tmp/perf-<pid>.map
  curl -OL https://aka.ms/perfcollect && sudo ./perfcollect install
  ./perfcollect collect <name> -collectsec 10 → trace.zip 拷回 Windows 用 PerfView 打开(1ms 采样)
  容器无人值守 → procdump -c 阈值多 dump

C. 非托管内存泄漏(工具"各自为政",打组合拳)
  第一步:!maddress 看内存类型分布(PAGE_READWRITE 占大头 = 非托管;⚠ 仅 windbg≥1.2402 分析此 dump 时可用,dotnet-dump analyze 不支持)
  malloc 系 → heaptrack dotnet xxx.dll → heaptrack_print 转文本带走
  mmap 大页 → perf record -p <pid> -g -e syscalls:sys_enter_mmap → perf script
  栈中 unresolved/[unknown] 符号(大概率 C# 方法)→ dotnet-dump + ip2md <地址> 映射回托管方法
  ⚠ Valgrind 不适用 .NET(仿真 CPU 地址虚拟、栈映射不出托管函数)——只用于纯 C/C++

D. 读懂信号(必修基础)
  能产 core 的 11 个信号(SIGQUIT=3/SIGABRT=6/SIGSEGV=11…);coreclr 在 abort 前先踩 dump
  dump 头 SI_USER = 用户态 kill/raise(自杀或他杀);SI_TKILL = tgkill;容器退出码 139 = 崩溃
```

**反模式(Top 7)**:
1. ulimit core 抓托管崩溃 → createdump 环境变量
2. docker run 不加 --privileged → 加
3. dump 目录不挂载写容器内 → -v 挂载
4. 对 .NET 用 Valgrind → heaptrack/perf + dotnet-dump 拼证据链
5. perf/heaptrack 前不开 PerfMapEnabled(栈全 [unknown])→ export 后再采;仍不全靠 ip2md 兜底
6. windbg 通杀思维搬到 Linux → 接受组合拳:非托管工具 + 托管工具两边拼调用链
7. Linux dump 业务帧 !Unknown 就当"dump 抓小了"或指望 PDB 解决(缺的第一层是 DLL 元数据,PDB 只是第二层)→ 同构建产物平铺进当前盘根 `publish` 目录(E8 两层论)

**版本差异**:环境变量前缀 2023 年文用 `COMPlus_`、2025 年文用 `DOTNET_`(官方:二者等价,新前缀为 DOTNET_);createdump 随 runtime 携带(路径含版本号);WinDbg 远程调试 Linux 需 ≥1.2402.24001.0;ProcDump for Linux 内部调 createdump。

**★ 覆盖边界(如实声明)**:cgroup 内存限制 / OOM Killer / k8s 资源配额与 GC 的交互**完全未覆盖**(现有实战经验无一处讨论);lldb+sos 官方路线未覆盖(实践中只用 gdb/gdbserver/dotnet-dump/WinDbg);容器仅单机 docker,无 sidecar/共享卷收集实践;符号服务(debuginfod)未涉及。涉及这些方向时,本 skill 只能给方向性建议并提示用户另行验证。

---

### E9. 体检路线(无症状 / 潜在问题扫描)

**适用**:用户只说"分析这个 dump""看看有没有潜在问题",或拿到陌生 dump 没有症状描述。先用分诊三问定性,再确认诉求;用户答"体检"则走全流程。dotnet-dump analyze 即可胜任(命令对照见 INDEX §3.1)。

**决策路径**:

```
第 0 步 分诊三问(30 秒,先定性)
  printexception(当前线程有异常?无 → 大概率不是崩溃 dump)
  + threads / clrstack -all(线程形态:工作线程全闲 vs 卡锁 vs 线程爆炸)
  + threadpool(CPU% / Running vs Idle / 队列积压)
  → 判定:崩溃现场(转 E6)/ 卡死现场(转 E5)/ 正常快照
    正常快照 → 如实告知用户"现场体征正常",再继续扫潜在问题

第 1 步 侦察技术栈(固定动作,决定后续全部方向)
  从线程栈与异步图读出框架/第三方库(ASP.NET Core / MongoDB 驱动 / Polly /
  WebApiClient / CSRedis / HttpClientFactory……),记下弹性策略与池化组件

第 2 步 体征集合
  eeheap -gc(Allocated vs Committed;堆数 == 核数)+ eeheap -loader(巨大 → 程序集泄漏)
  + finalizequeue(终结器积压)+ gchandles(pinned 句柄)+ dumpheap -min 85000 -stat(LOH 住客)
  + eeversion → 核对版本支持状态(INDEX §7;EOL 必报为风险项)

第 3 步 异步图
  dumpasync:在途请求数(STACK 段数)、聚合 Awaiting 类型看卡点分布、帧链看中间件/弹性策略
  异步服务端线程栈常全闲,答案在这里

第 4 步 跨类型比例法(核心动作)
  取一组因果关联类型分别计数:API 代理 / HttpClient / HttpConnection /
  异步状态机(dumpheap -stat -type '<SendAsync>d__' 类名)/ 在途请求
  常态:持有量 ≈ 活跃量 × 小倍数;活跃基线 = dumpasync 在途数 + 状态机计数
  数量级悬殊 = 未完成操作积压 → 转第 5 步定持有者

第 5 步 gcroot 抽样定持有者
  dumpheap -mt <MT> 列表 → 等距取 10+ 地址逐个 gcroot:
    "Found 0 unique roots" 占比高 → 未回收垃圾(Gen2 GC 懒),不是泄漏
    多数有根 → 真持有,看路径收敛方向(static 集合 / 在途异步链 / 定时器回调)
  ⚠ 路径穿过全局共享结构(epoll 注册表 / TimerQueue 链表 / 中间件单例)不算归因(铁律 3)

第 6 步 报告与二次取证
  按 体征正常项 → 潜在风险(证据强度排序)→ 轻微观察 三段输出
  积累型嫌疑必须以双快照建议收尾:"隔 1-2 小时再抓一份,比对三组计数
  (持有量/活跃量/堆大小)验证增长趋势"——单快照无法区分"稳态持有"与"单调泄漏"
```

**边界**:体检只查得出 dump 里已留下物证的潜在问题,替代不了实时监控(见边界与反场景);无 DLL 元数据时业务帧为 `!Unknown`(Windows 分析 Linux dump 把同构建产物放当前盘根 `publish` 目录即可,见 E8 两层论),源码行号则进一步需要 PDB。

---

## 边界与反场景 ★

### 不要在以下情况使用此 skill

- **纯代码风格/重构咨询**:本 skill 输出取证路线,不做"代码怎么写更优雅"。
- **SQL 数据库自身优化**:连接池耗尽、慢 SQL 拖死线程池的**进程侧表现**归本 skill;索引/执行计划归数据库。
- **事前监控体系设计**:经验几乎全来自事后 dump 分析,EventCounters/OpenTelemetry/告警设计未覆盖——别用本 skill 冒充监控专家。
- **cgroup/k8s 容器限额问题**:见 E8 覆盖边界声明。
- **.NET 9/10+ 新机制考证**:经验截至 .NET 8 时代(零星提及 .NET 10 DATAS/DI 修复),最新行为需另行验证。

### 经验反复警告的失败模式(跨场景总纲)

- 第一眼看到的往往是程序故意让你看到的——dump 里最显眼的异常常是伴生现象。
- 只是记日志看代码不可能找得出问题——显卡/辐射/安全软件类根因不在代码里。
- 上游对线程池洪水猛兽般的 DDOS,下游倾家荡产去承接也无济于事——SetMinThreads 缓解不了上游滥用,治本永远在调用模式。
- 不要全信工具——ETW 开销扭曲行为、DotMemory 与 windbg 的 free 口径不同、!tp 积压数有 sos bug。

### 已知覆盖盲点

- **Windows + WinDbg 偏重**:多数实战案例在 Windows 上解决;Linux 侧首个完整证据链案例为案例 6(容器 + 静默型异步积压),深度仍浅。
- **案例代码为复现 Demo**:生产原代码不可见,根因依赖转述——使用者应以**证据链方法**为准,而非照搬某案例结论。
- **弱于预防**:几乎没有"如何设计系统避免这类故障"的前置内容(监控、限流、容量规划)。

### 容易混淆的邻近方法论

- **APM/可观测性方法论**(OpenTelemetry、分布式追踪):互补关系——APM 发现问题,本 skill 解剖问题。
- **通用性能优化书籍**(如《Performance Conquests》):本 skill 更"法医"(postmortem 取证),轻"养生"(日常优化)。

---

## 相关 skills

- depends-on: 无(自包含;命令细节查 INDEX.md)
- contrasts-with: APM/监控类 skill(事前 vs 事后)
- composes-with: 数据库调优 skill(进程侧 ↔ SQL 侧)、代码审查 skill(取证定位 → 修复审查)
