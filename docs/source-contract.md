# MaintenanceLibrary 来源约定

此服务管理适用分支领取、资料引用解释及设备作业包接收。
当前常规业务使用一个选定来源上下文处理直接列出的记录。目录请求为 `GET /library/equipment`，返回 `issue` 与 `modules`。每个目录成员以 `id`、`href` 提供来源身份与原文位置，原文中的 `module` 和 `issue` 必须与目录一致。

## 记录含义

```json
{
  "module": "DM100",
  "issue": "2",
  "equipment": "EQ-A",
  "title": "安全检查",
  "approved": true,
  "body": "断电后进行外观检查"
}
```

这里的字段是来源提供的原始声明，数值文本必须符合十进制规则，不能把空白或未知值转换成零。领域解释保留资料核准、设备类别归属、资料号与版次。只有所选范围内且有充分常规依据的记录列入当前收件；其他范围、待确认、历史和冲突分别保留结果，不用覆盖旧原文消除分歧。

## 本地合作源

`fixtures/source.json` 的 `resources` 是本地来源的 URL 路径到响应正文的映射；只绑定回环地址，不连接真实监管、银行或合作方。原文可通过目录声明的位置取得。同一来源也可发布关联资料，当前示例的关联资料位置为 `/library/equipment/relations/DM100`，字段保留来源的业务含义：

```json
{
  "applicability": {
    "modification": "M"
  },
  "references": [
    {
      "module": "DM200",
      "issue": "2",
      "condition": "M-installed",
      "kind": "fixed"
    },
    {
      "module": "DM500",
      "issue": "2",
      "condition": "N-absent",
      "kind": "alternative",
      "group": "G500"
    },
    {
      "module": "DM300",
      "issue": "1",
      "condition": "unconditional",
      "kind": "fixed"
    }
  ]
}
```

### 适用条件的三态解释

`condition` 的语法为 `<改装号>-installed` 或 `<改装号>-absent`，另有显式 `unconditional` 表示任何设备状态都适用。设备装配记录只陈述登记过的事实（`installed`/`absent`）；记录中没有提到的改装一律按**未知**处理，条件评估结果为 `met`（满足）、`not-met`（不满足）或 `unknown`（未知）：

- 条件不满足的引用被明确**排除**，排除不是缺件，不阻断资料包；
- 条件未知的引用进入 `unresolved-condition` 挂起缺口，**不能当成不适用**；
- 文档级 `applicability` 只约束没有自带 `condition` 的引用；引用一旦声明自己的条件（含 `unconditional`），就以引用自身为准。

### 固定引用与替代引用

- `kind: "fixed"` 是该版次固定的前置检查或警示，条件满足时必须纳入；
- `kind: "alternative"` 必须带 `group`，表示允许在声明的适用范围内替代同组固定资料。系统只把可适用的替代标记为 `substitute-proposed`/`substitute-alternate` 并保留来源声明，**不替技术负责人批准替代**，存在待批准替代时资料包不得视为完成；
- 同组全部分支条件不满足时整组排除且不计缺件；存在条件未知的分支时整组挂起；没有条件满足且可取得的成员时记为 `group-gap` 真实缺口。

### 版次精确取件与来源撤下

引用始终按明确的 `module` + `issue` 取件。来源只给得出其他版次、或该版次原文取不回（HTTP 404/403/503）时，记为 `record-missing` 真实缺口，**不自动套用最新版**。关联资料位置取不回时记为 `relation-unavailable`，阻断引用链而不是假定“该页没有前置引用”；HTTP 状态码不会被自行解释成业务删除。

`fixtureSource` 支持独立实例、指定路径返回码、一次性来源故障、响应延迟与 `replace` 更新资源；访问记录保留实际请求路径，不凭空生成未收到的响应。测试在进程内操作夹具，不提供对外开放的管理接口。目录不承诺所有关联资料与当前目录同时发布；HTTP 404、403、503 不能自行解释为业务删除。

## 设备资料包与复核

`src/package.mjs` 依据一台具体设备的装配记录（`unit`、`equipment`、`modifications`）从种子资料出发沿关联引用规划资料包；`src/planner.mjs` 负责三态门控、引用遍历（含环保护）与替代组决议。资料包与包内条目、复核结论分别落库：

- 包内固化建包时的设备状态快照与每个引用的纳入/排除/缺口理由，之后装配记录补正**不改写旧包**；
- `reassessPackage` 用补正后的记录重新规划，只追加复核结论，逐节点说明 `gained`/`lost`/`status`/`new-gap`/`no-longer-declared`，并给出原包是否仍足以支撑当前作业的解释；
- `src/report.mjs` 输出可向维修点解释的领取报告：所依据的设备状态、纳入与排除的引用、待批准替代、尚缺的条件或原文。

## 原文和收件

原文字节按 SHA-256 寻址，SQLite 保存来源位置、观察时间、收件范围、业务身份、领域记录与决策。收到原文不等于领域接收成功；重复的同一内容不新增收据，同一身份的不同内容不会覆盖原件。`.data/` 仅用于本机数据，演示使用临时目录，运行结束关闭服务并清理临时状态。
