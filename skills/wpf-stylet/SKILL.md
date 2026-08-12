---
name: wpf-stylet
description: 'WPF + Stylet MVVM 框架开发指南。涵盖 ViewModel-first 架构、Screen 生命周期、Conductor 导航、WindowManager 弹窗、ActionMessage 命令绑定、StyletIoC 依赖注入、验证等核心主题，以及常见陷阱和最佳实践。'
---

# WPF Stylet MVVM 框架

Stylet 是一个轻量但强大的 ViewModel-first MVVM 框架（.NET 4.5.2+ / .NET Core 3.0+ / .NET 5+），
灵感来自 Caliburn.Micro，但去掉了大部分"魔法"，代之以更明确、更易测试的设计。

> **TL;DR.** 继承 `Screen` 获得完整生命周期；用 `SetAndNotify` 驱动属性通知；
> 用 `Conductor<T>` 管理子 ViewModel 的激活/停用/关闭；通过 `IWindowManager` 弹窗；
> 用 `{s:Action MethodName}` 绑定按钮到方法；在 `Bootstrapper<T>` 中配置 IoC 和启动流程。

---

## 适用场景

- 使用 Stylet 框架开发 WPF 桌面应用
- 需要 ViewModel-first 架构（ViewModel 创建并拥有子 ViewModel）
- 需要管理 ViewModel 生命周期（激活/停用/关闭/取消关闭）
- 选项卡界面、向导界面、多窗口应用
- 诊断"绑定不更新"、"弹窗不显示"、"生命周期回调不触发"等问题

---

## 指导流程

用户寻求 WPF/Stylet 开发指导时，按以下三步执行：

### Step 1: 识别用户阶段（输入：用户问题 → 输出：阶段判定）

| 用户特征 | 阶段 | 指导章节 |
|----------|------|----------|
| 新建项目、搭骨架、配置 Bootstrapper | 起步 | 项目启动配置、ViewModel-First 架构、最佳实践→项目结构 |
| 实现具体功能（导航/弹窗/命令绑定/注入/验证/消息通信） | 开发 | 对应功能章节：Conductor / WindowManager / ActionMessage / StyletIoC / ValidatingModelBase / EventAggregator |
| 界面不更新、弹窗不显示、回调不触发、卡顿/泄漏/CPU 飙高 | 排障 | 常见陷阱、性能内存与 CPU 陷阱 |

无法判定阶段时，直接问用户：项目是刚起步，还是已有代码出了问题？

### Step 2: 按阶段输出指导（输入：阶段 → 输出：可执行代码或排查步骤）

- **起步**：先给项目结构与 App.xaml / Bootstrapper 配置，再给最小可运行的 ShellViewModel / ShellView；强调命名约定 `XxxViewModel ↔ XxxView`，写明删除 `StartupUri`。
- **开发**：先给 ViewModel 代码，再给 View 绑定代码；说明涉及的生命周期回调（OnViewLoaded / OnActivate / OnDeactivate / OnClose）各自触发时机。
- **排障**：先按发生频率从高到低列出可能原因，再给逐步排查步骤；每步包含具体操作和判断标准（看到什么现象说明命中）。

### Step 3: 输出前对照自检（输入：待输出代码 → 输出：修正后的代码）

输出代码前对照以下 5 条逐项检查，命中任一条先修正再输出：

1. 属性赋值是否用 `SetAndNotify`，而非直接给字段赋值？
2. 需要生命周期的 ViewModel 是否继承 `Screen`，而非只继承 `PropertyChangedBase`？
3. Conductor 子项增删是否用 `ActivateItem` / `CloseItem`，而非直接操作 `Items`？
4. Guard 属性 `CanXxx` 依赖的状态变化时，是否手动调用了 `NotifyOfPropertyChange(nameof(CanXxx))`？
5. 后台线程更新 UI 绑定属性，是否经过 `Execute.OnUIThread` 调度？

### 检查点（必须停下等用户确认）

🔴 **CHECKPOINT A · 生成代码前确认架构决策（🛑 STOP）**

用户需求涉及以下任一架构决策时，Step 1 之后必须先列出选项与权衡，等用户选定再进入 Step 2，不得替用户拍板：

- 导航结构：`Conductor<T>` 单页切换（切换即 Close）还是 `Collection.OneActive`（切换只 Deactivate、保留状态）——对比见 Conductor 章节的类型表
- 次级页面（设置页等）落点：内嵌页面还是 `IWindowManager` 模态弹窗
- ViewModel 间通信方式：Conductor 父子关系还是 EventAggregator 平级消息

需求不涉及架构决策（修单个绑定、补一个方法、回答概念问题）时直接进入 Step 2。

🔴 **CHECKPOINT B · 给出修复方案前确认根因（🛑 STOP）**

排障阶段通过排查步骤定位到问题后，必须先向用户说明根因与判定依据（哪一步、看到什么现象命中），等用户确认后再给修复代码。根因未确认不改代码——避免按错误归因做破坏性修改。

---

## 项目启动配置

### Bootstrapper

`Bootstrapper<TRootViewModel>` 是应用入口，负责配置 IoC 容器、创建根 ViewModel 并显示。

```csharp
public class Bootstrapper : Bootstrapper<ShellViewModel>
{
    protected override void OnStart() { /* 应用启动后、IoC 配置前，适合初始化日志等 */ }

    protected override void ConfigureIoC(IStyletIoCBuilder builder)
    {
        // 具体类自动自绑定，只需绑定接口
        builder.Bind<INavigationService>().To<NavigationService>();
        builder.Bind<IDataRepository>().To<DataRepository>().InSingletonScope();
    }

    protected override void Configure() { /* IoC 已创建，根 ViewModel 尚未启动 */ }
    protected override void OnLaunch() { /* 根 ViewModel 已启动后调用 */ }
    protected override void OnExit(ExitEventArgs e) { /* 应用退出 */ }
    protected override void OnUnhandledException(DispatcherUnhandledExceptionEventArgs e) { /* 全局异常 */ }
}
```

### App.xaml 配置

删除 `StartupUri`，添加 Stylet 的 `ApplicationLoader` 和 Bootstrapper 引用：

```xml
<Application x:Class="MyApp.App"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:s="https://github.com/canton7/Stylet"
             xmlns:local="clr-namespace:MyApp">
    <Application.Resources>
        <s:ApplicationLoader>
            <s:ApplicationLoader.Bootstrapper>
                <local:Bootstrapper/>
            </s:ApplicationLoader.Bootstrapper>
        </s:ApplicationLoader>
    </Application.Resources>
</Application>
```

---

## ViewModel-First 架构

Stylet 采用 ViewModel-first 模式：**ViewModel 创建并拥有子 ViewModel**，框架通过命名约定自动匹配 View。

### View/ViewModel 命名约定

`ViewManager` 默认按命名约定查找 View：将 ViewModel 类名中的 `ViewModel` 替换为 `View`。

| ViewModel | View |
|-----------|------|
| `ShellViewModel` | `ShellView` |
| `LoginPageViewModel` | `LoginPageView` |
| `UserDetailDialogViewModel` | `UserDetailDialogView` |

命名不匹配会导致 View 找不到，显示空白或报错。

### 为什么不用 View-First

Stylet 采用 ViewModel-first 而非 View-first：ViewModel 创建并拥有子 ViewModel，框架通过命名约定自动匹配 View。
这避免了 View code-behind 承担逻辑、ViewModel 间难以组合、以及从 ViewModel 打开窗口时需要依赖 View 等问题。

---

## PropertyChangedBase —— 属性通知基类

所有需要数据绑定的 ViewModel 都应继承 `PropertyChangedBase`（或其子类 `Screen`）。

### SetAndNotify —— 属性变更通知

```csharp
public class UserViewModel : PropertyChangedBase
{
    private string _name;
    public string Name
    {
        get => _name;
        set => SetAndNotify(ref _name, value);
    }

    private int _age;
    public int Age
    {
        get => _age;
        set
        {
            if (SetAndNotify(ref _age, value))
            {
                // SetAndNotify 返回 bool，表示值是否真的变了
                NotifyOfPropertyChange(nameof(DisplayText));
            }
        }
    }

    public string DisplayText => $"{Name} ({Age} 岁)";
}
```

### 联动属性通知

当多个属性变化需要触发同一个计算属性时，用构造函数中的 `Bind` 方法更清晰：

```csharp
public class UserViewModel : PropertyChangedBase
{
    public UserViewModel()
    {
        this.Bind(s => s.FirstName, (o, e) => NotifyOfPropertyChange(nameof(FullName)));
        this.Bind(s => s.LastName, (o, e) => NotifyOfPropertyChange(nameof(FullName)));
    }

    private string _firstName;
    public string FirstName
    {
        get => _firstName;
        set => SetAndNotify(ref _firstName, value);
    }

    private string _lastName;
    public string LastName
    {
        get => _lastName;
        set => SetAndNotify(ref _lastName, value);
    }

    public string FullName => $"{FirstName} {LastName}";
}
```

---

## Screen —— ViewModel 生命周期

`Screen` 继承自 `PropertyChangedBase`，增加了完整的生命周期管理。

### 生命周期状态

```
[创建] → Deactivated → Activated ⇄ Deactivated → ... → Closed
```

- **Activated**: ViewModel 正在显示
- **Deactivated**: ViewModel 存在但未显示（例如切换到了另一个选项卡）
- **Closed**: ViewModel 已关闭（可从 Closed 再次 Activated）

### 生命周期回调

```csharp
public class EditorViewModel : Screen
{
    // View 加载完成后调用（只调用一次）
    protected override void OnViewLoaded()
    {
        // 适合做需要 View 存在的初始化，如 Focus 某个控件
    }

    // 激活时调用（可能多次）
    protected override void OnActivate()
    {
        // 适合启动定时器、订阅事件等
    }

    // 停用时调用（可能多次）
    protected override void OnDeactivate()
    {
        // 适合停止定时器、取消订阅等
    }

    // 关闭时调用（只调用一次）
    protected override void OnClose()
    {
        // 适合释放非托管资源
    }

    // 询问是否可以关闭（返回 false 取消关闭）
    public override Task<bool> CanCloseAsync()
    {
        if (HasUnsavedChanges)
        {
            var result = MessageBox.Show("是否保存更改？", "确认",
                MessageBoxButton.YesNoCancel);
            if (result == MessageBoxResult.Cancel)
                return Task.FromResult(false);
            if (result == MessageBoxResult.Yes)
                Save();
        }
        return Task.FromResult(true);
    }
}
```

### DisplayName 与窗口标题

`Screen` 实现了 `IHaveDisplayName`。`DisplayName` 会自动用作窗口/对话框的标题：

```csharp
public class EditorViewModel : Screen
{
    public EditorViewModel()
    {
        DisplayName = "代码编辑器";
    }
}
```

### IDisposable 支持

如果 ViewModel 实现了 `IDisposable`，关闭后会自动调用 `Dispose()`。

---

## Conductor —— 管理子 ViewModel

Conductor 是拥有并管理子 ViewModel 生命周期的 ViewModel。典型场景：选项卡界面、向导、内容区域切换。

### 三种 Conductor 类型

| 类型 | 场景 | 说明 |
|------|------|------|
| `Conductor<T>` | 单页面切换 | 同一时刻只有一个子项，切换时旧的 Close、新的 Activate |
| `Conductor<T>.Collection.OneActive` | 选项卡 | 维护子项集合，同时只激活一个（其余 Deactivate 但不 Close） |
| `Conductor<T>.Collection.AllActive` | 面板/Dashboard | 所有子项同时激活显示 |

### Conductor&lt;T&gt; —— 单页面切换

```csharp
public class ShellViewModel : Conductor<IScreen>
{
    public void ShowHome()
    {
        ActivateItem(new HomeViewModel());
    }

    public void ShowSettings()
    {
        ActivateItem(new SettingsViewModel());
    }
}
```

对应的 View 中使用 `ContentControl` 绑定 `ActiveItem`：

```xml
<Window x:Class="MyApp.ShellView"
        xmlns:s="https://github.com/canton7/Stylet">
    <Grid>
        <StackPanel Orientation="Horizontal">
            <Button Command="{s:Action ShowHome}" Content="首页"/>
            <Button Command="{s:Action ShowSettings}" Content="设置"/>
        </StackPanel>
        <!-- Stylet 自动为 ActiveItem 找到并显示对应的 View -->
        <ContentControl s:View.Model="{Binding ActiveItem}"/>
    </Grid>
</Window>
```

### Conductor&lt;T&gt;.Collection.OneActive —— 选项卡界面

```csharp
public class ShellViewModel : Conductor<IScreen>.Collection.OneActive
{
    public void OpenDocument(string filePath)
    {
        // 检查是否已打开
        var existing = Items.OfType<DocumentViewModel>()
            .FirstOrDefault(d => d.FilePath == filePath);
        if (existing != null)
        {
            ActiveItem = existing;
            return;
        }

        var doc = new DocumentViewModel(filePath);
        ActivateItem(doc);
    }

    public void CloseDocument(DocumentViewModel doc)
    {
        // CloseItem 会先调用 CanCloseAsync，返回 true 才真正关闭
        CloseItem(doc);
    }
}
```

View 中使用 `TabControl`：

```xml
<TabControl ItemsSource="{Binding Items}"
            SelectedItem="{Binding ActiveItem}">
    <TabControl.ItemTemplate>
        <DataTemplate>
            <TextBlock Text="{Binding DisplayName}"/>
        </DataTemplate>
    </TabControl.ItemTemplate>
    <TabControl.ContentTemplate>
        <DataTemplate>
            <ContentControl s:View.Model="{Binding}"/>
        </DataTemplate>
    </TabControl.ContentTemplate>
</TabControl>
```

### IChild —— 子 ViewModel 感知父 Conductor

子 ViewModel 继承 `Screen` 后自动实现 `IChild`，可通过 `Parent` 属性访问其 Conductor：

```csharp
public class DocumentViewModel : Screen
{
    public void Close()
    {
        // 请求父 Conductor 关闭自己
        ((IConductor)Parent).CloseItem(this);
    }
}
```

---

## WindowManager —— 弹窗与对话框

通过注入 `IWindowManager` 从 ViewModel 中打开窗口或对话框，保持 ViewModel 的可测试性。

### 打开窗口

```csharp
public class ShellViewModel : Screen
{
    private readonly IWindowManager _windowManager;

    public ShellViewModel(IWindowManager windowManager)
    {
        _windowManager = windowManager;
    }

    public void OpenSettingsWindow()
    {
        var vm = new SettingsViewModel();
        _windowManager.ShowWindow(vm);
    }
}
```

### 打开模态对话框

```csharp
public void ShowConfirmDialog()
{
    var vm = new ConfirmDialogViewModel
    {
        DisplayName = "确认操作",
        Message = "确定要删除吗？"
    };

    bool? result = _windowManager.ShowDialog(vm);
    if (result.GetValueOrDefault(false))
    {
        // 用户点击了确认
        PerformDelete();
    }
}
```

### 从 ViewModel 内部关闭对话框

```csharp
public class ConfirmDialogViewModel : Screen
{
    public string Message { get; set; }

    // 确认按钮
    public void Confirm()
    {
        RequestClose(true);  // DialogResult = true
    }

    // 取消按钮
    public void Cancel()
    {
        RequestClose(false); // DialogResult = false
    }
}
```

---

## ActionMessage —— 命令绑定

`{s:Action}` 标记扩展将 UI 事件直接绑定到 ViewModel 方法，替代手写 `ICommand` 属性。

### 基本用法

```xml
<!-- 无参数 -->
<Button Command="{s:Action Save}" Content="保存"/>

<!-- 带 CommandParameter -->
<Button Command="{s:Action Delete}" CommandParameter="{Binding SelectedItem}" Content="删除"/>
```

```csharp
public class ListViewModel : Screen
{
    public void Save() { /* ... */ }

    public void Delete(Item item)
    {
        Items.Remove(item);
    }
}
```

### Guard Properties —— 控制按钮可用性

方法名前面加 `Can` 的 bool 属性会自动控制按钮的 `IsEnabled`：

```csharp
public class EditorViewModel : Screen
{
    private bool _isDirty;

    // CanSave 控制 Save 按钮是否可用
    public bool CanSave => _isDirty;

    public void Save()
    {
        // 保存逻辑...
        _isDirty = false;
        NotifyOfPropertyChange(nameof(CanSave));
    }

    private string _content;
    public string Content
    {
        get => _content;
        set
        {
            SetAndNotify(ref _content, value);
            _isDirty = true;
            NotifyOfPropertyChange(nameof(CanSave));
        }
    }
}
```

### 异步 Action 方法

Action 方法可以是 `async Task`，Stylet 会正确处理：

```csharp
public class DataListViewModel : Screen
{
    private readonly IDataRepository _repository;
    private bool _isLoading;
    public bool IsLoading
    {
        get => _isLoading;
        set => SetAndNotify(ref _isLoading, value);
    }

    private ObservableCollection<Item> _data;
    public ObservableCollection<Item> Data
    {
        get => _data;
        set => SetAndNotify(ref _data, value);
    }

    public DataListViewModel(IDataRepository repository)
    {
        _repository = repository;
    }

    public async Task LoadDataAsync()
    {
        IsLoading = true;
        try
        {
            Data = new ObservableCollection<Item>(await _repository.GetAllAsync());
        }
        finally
        {
            IsLoading = false;
        }
    }
}
```

---

## StyletIoC —— 依赖注入

Stylet 内置轻量 IoC 容器 StyletIoC，也可替换为 Autofac、Unity 等第三方容器。

### 在 Bootstrapper 中注册

```csharp
protected override void ConfigureIoC(IStyletIoCBuilder builder)
{
    // 接口绑定到实现（每次请求创建新实例）
    builder.Bind<ILogger>().To<Logger>();

    // 单例
    builder.Bind<IAppSettings>().To<AppSettings>().InSingletonScope();

    // 绑定到工厂方法
    builder.Bind<HttpClient>().ToFactory(c =>
    {
        var client = new HttpClient();
        client.BaseAddress = new Uri("https://api.example.com");
        return client;
    }).InSingletonScope();

    // 具体类自动自绑定，无需显式注册
}
```

### 构造函数注入

StyletIoC 自动解析构造函数依赖：

```csharp
public class ShellViewModel : Screen
{
    private readonly ILogger _logger;
    private readonly IAppSettings _settings;

    // 依赖通过构造函数自动注入
    public ShellViewModel(ILogger logger, IAppSettings settings)
    {
        _logger = logger;
        _settings = settings;
    }
}
```

### 使用第三方 IoC 容器

继承 `BootstrapperBase<TRootViewModel>`（而非 `Bootstrapper<T>`），自行配置容器。
需要重写三个方法将解析委托给第三方容器，并注册 Stylet 自身的核心服务：

```csharp
public class Bootstrapper : BootstrapperBase<ShellViewModel>
{
    private IContainer _container;

    protected override void ConfigureIoC(IStyletIoCBuilder builder)
    {
        // 不使用 StyletIoC，留空
    }

    protected override void Configure()
    {
        var builder = new ContainerBuilder(); // Autofac 示例

        // 必须注册 Stylet 自身的核心服务
        builder.RegisterType<WindowManager>().As<IWindowManager>().SingleInstance();
        builder.RegisterType<ViewManager>().As<IViewManager>().SingleInstance();
        builder.RegisterType<EventAggregator>().As<IEventAggregator>().SingleInstance();
        builder.RegisterType<MessageBoxViewModel>().As<IMessageBoxViewModel>();

        // 注册自己的服务
        builder.RegisterType<Logger>().As<ILogger>();
        builder.RegisterType<ShellViewModel>();

        _container = builder.Build();
    }

    // 必须重写以下三个方法
    protected override object GetInstance(Type serviceType, string key)
    {
        return key == null ? _container.Resolve(serviceType) : _container.ResolveNamed(key, serviceType);
    }

    protected override IEnumerable<object> GetAllInstances(Type serviceType)
    {
        return (IEnumerable<object>)_container.Resolve(typeof(IEnumerable<>).MakeGenericType(serviceType));
    }

    protected override void BuildUp(object instance)
    {
        _container.InjectProperties(instance);
    }
}
```

> Stylet 的 `Bootstrappers` 目录（[GitHub](https://github.com/canton7/Stylet/tree/master/Bootstrappers)）
> 提供了 Autofac、Ninject、Unity 等容器的示例 Bootstrapper，可直接参考。

---

## ValidatingModelBase —— 输入验证

`ValidatingModelBase` 继承自 `PropertyChangedBase`，实现了 `INotifyDataErrorInfo`。
`Screen` 已继承 `ValidatingModelBase`，所以所有 Screen 都自带验证能力。

### 使用方式

```csharp
public class LoginViewModel : Screen
{
    private string _username;
    public string Username
    {
        get => _username;
        set => SetAndNotify(ref _username, value);
    }

    private string _password;
    public string Password
    {
        get => _password;
        set => SetAndNotify(ref _password, value);
    }

    // 提供自定义 IModelValidator 实现
    protected override void OnViewLoaded()
    {
        Validator = new FluentModelValidator<LoginViewModel>(this);
    }

    public bool CanLogin => !HasErrors
        && !string.IsNullOrWhiteSpace(Username)
        && !string.IsNullOrWhiteSpace(Password);

    public async Task Login()
    {
        // 手动触发全量验证（通过 Validator 属性调用）
        await Validator.ValidateAllPropertiesAsync();
        if (HasErrors)
            return;

        // 执行登录逻辑
    }
}
```

### View 中显示验证错误

```xml
<TextBox Text="{Binding Username, UpdateSourceTrigger=PropertyChanged,
                        ValidatesOnNotifyDataErrors=True}"/>
```

---

## View.Model 标记扩展 —— 嵌套 ViewModel 的 View 绑定

`s:View.Model` 将 ViewModel 属性自动解析为对应的 View 并渲染。
单个 ViewModel 属性用 `ContentControl`（参见上文 Conductor 示例），集合用 `ItemsControl`：

```xml
<ItemsControl ItemsSource="{Binding Panels}">
    <ItemsControl.ItemTemplate>
        <DataTemplate>
            <ContentControl s:View.Model="{Binding}"/>
        </DataTemplate>
    </ItemsControl.ItemTemplate>
</ItemsControl>
```

---

## Execute —— 线程调度工具

Stylet 提供 `Execute` 静态类用于 UI 线程调度：

```csharp
// 在 UI 线程上执行
Execute.OnUIThread(() =>
{
    // 更新 UI 绑定的属性
    StatusMessage = "加载完成";
});

// 设置全局属性通知调度到 UI 线程
Execute.DefaultPropertyChangedDispatcher = Execute.OnUIThread;
```

---

## EventAggregator —— 发布/订阅消息

Stylet 内置 `IEventAggregator`，用于不相关的 ViewModel 之间的解耦通信（继承自 Caliburn.Micro）。
典型场景：状态栏 ViewModel 响应文档 ViewModel 的事件、全局主题切换等。

### 定义消息

```csharp
public sealed record ThemeChangedMessage(AppTheme NewTheme);
public sealed record UserLoggedInMessage(string UserName);
```

### 订阅消息

实现 `IHandle<T>` 接口并通过 `Subscribe` 注册：

```csharp
public class StatusBarViewModel : Screen, IHandle<ThemeChangedMessage>
{
    private readonly IEventAggregator _eventAggregator;

    public StatusBarViewModel(IEventAggregator eventAggregator)
    {
        _eventAggregator = eventAggregator;
        _eventAggregator.Subscribe(this);
    }

    public void Handle(ThemeChangedMessage message)
    {
        // 响应主题切换
        CurrentTheme = message.NewTheme;
    }

    protected override void OnClose()
    {
        _eventAggregator.Unsubscribe(this);
    }
}
```

### 发布消息

```csharp
public class SettingsViewModel : Screen
{
    private readonly IEventAggregator _eventAggregator;

    public SettingsViewModel(IEventAggregator eventAggregator)
    {
        _eventAggregator = eventAggregator;
    }

    public void ApplyTheme(AppTheme theme)
    {
        _eventAggregator.Publish(new ThemeChangedMessage(theme));
    }
}
```

### 注意事项

- `IEventAggregator` 需通过 IoC 注入（StyletIoC 自动注册为单例）
- 关闭 ViewModel 时务必调用 `Unsubscribe`，防止内存泄漏
- `Publish` 是同步调用；如需异步处理，在 `Handle` 中使用 `async` + `Execute.OnUIThread`
- 与 Conductor 的父子通信互补：Conductor 管理父子关系，EventAggregator 处理平级通信

---

## 常见陷阱

### 1. 忘记继承 Screen，导致生命周期回调不触发

`OnActivate`、`OnDeactivate`、`OnClose`、`OnViewLoaded` 等回调只在继承 `Screen`
的 ViewModel 上生效。继承 `PropertyChangedBase` 时这些方法永远不会被调用。

### 2. View/ViewModel 命名不匹配，View 找不到

Stylet 的 `ViewManager` 默认将 `ViewModel` 后缀替换为 `View` 来查找 View 类。
如果命名不符合约定，View 无法自动匹配，界面显示空白。

```
✗ ShellVM ↔ ShellView     （不匹配，应为 ShellViewModel）
✗ MyModel ↔ MyView        （不匹配，应为 MyViewModel）
✓ ShellViewModel ↔ ShellView
✓ UserDetailDialogViewModel ↔ UserDetailDialogView
```

### 3. 直接用字段赋值而非 SetAndNotify，UI 不更新

```csharp
// 错误：UI 不知道值变了
_name = value;

// 正确：触发 PropertyChanged 通知
SetAndNotify(ref _name, value);
```

### 4. Guard Property (CanXxx) 忘记触发通知

Guard 属性变化后必须手动通知，否则按钮的启用/禁用状态不会更新：

```csharp
public string Content
{
    get => _content;
    set
    {
        SetAndNotify(ref _content, value);
        // 必须手动通知 CanSave，否则保存按钮状态不更新
        NotifyOfPropertyChange(nameof(CanSave));
    }
}
```

### 5. 在 Conductor 中直接操作子 ViewModel 而绕过生命周期

```csharp
// 错误：子 ViewModel 的 OnActivate/OnDeactivate 不会被调用
Items.Add(newTab);
ActiveItem = newTab;

// 正确：通过 ActivateItem 管理生命周期
ActivateItem(newTab);
```

### 6. Conductor.ActiveItem 绑定抛出异常被吞掉

在 `Conductor<T>.Collection.OneActive` 中，如果 `ActiveItem` 被双向绑定，
设置时遇到的异常可能被静默吞掉。检查 `ActiveItem` 赋值逻辑中的异常。

### 7. ShowDialog 返回值未做空值检查

`IWindowManager.ShowDialog` 返回 `bool?`。当用户通过窗口的 X 按钮关闭对话框（而非通过 `RequestClose`）时，
返回值为 `null`。直接访问 `.Value` 会抛 `InvalidOperationException`：

```csharp
// 错误：用户点 X 关闭时 .Value 抛 InvalidOperationException
bool? result = _windowManager.ShowDialog(vm);
if (result.Value) // null 时崩溃
{
    PerformAction();
}

// 正确
bool? result = _windowManager.ShowDialog(vm);
if (result.GetValueOrDefault(false))
{
    // 用户确认
}
```

### 8. 后台线程更新 UI 属性未调度

Stylet 不会自动将 `PropertyChanged` 调度到 UI 线程（默认 `PropertyChangedDispatcher` 是
`a => a()`，即直接执行）。从后台线程更新绑定属性时必须手动调度：

```csharp
await Task.Run(() =>
{
    var data = LoadHeavyData();
    Execute.OnUIThread(() => Data = data);
});
```

### 9. OnActivate 中做耗时操作导致 UI 卡顿

`OnActivate` 是同步方法，在其中执行耗时操作会阻塞 UI 线程。
使用 `OnViewLoaded` 配合 `async` 模式，或确保耗时操作在后台执行：

```csharp
protected override void OnViewLoaded()
{
    _ = LoadDataAsync(); // fire-and-forget，注意异常处理
}

private async Task LoadDataAsync()
{
    IsLoading = true;
    try
    {
        Data = await _repository.GetAllAsync();
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "加载数据失败");
    }
    finally
    {
        IsLoading = false;
    }
}
```

### 10. Screen 生命周期状态跳转异常

Screen 的状态机要求：从 Activated 到 Closed 必须先经过 Deactivated，不能直接跳过。
（Closed → Deactivated 是允许的，框架会自动先激活再停用。）
确保使用 `ActivateItem` / `CloseItem` 等 Conductor 方法管理状态转换，
而非手动调用子 ViewModel 的生命周期方法，否则会触发非法状态转换异常。

### 11. ViewModel 构造函数中访问 View

构造函数执行时 View 尚未创建。需要访问 View 的操作（如 Focus、获取控件尺寸）
必须放在 `OnViewLoaded` 中。

### 12. IDisposable ViewModel 未被释放

只有 ViewModel 被 Conductor 关闭（通过 `CloseItem` 或 Conductor 自身关闭）时，
`Dispose` 才会被调用。如果 ViewModel 被 Conductor 的 `DisposeChildren = false` 配置跳过，
或者被直接丢弃而没有经过关闭流程，资源不会被释放。

---

## 性能、内存与 CPU 陷阱

WPF 应用最常见的三类性能问题：UI 卡顿、内存泄漏、CPU 飙高。以下是 Stylet 场景下的高频踩坑点。

### UI 卡顿

#### 1. ObservableCollection 逐条 Add 触发 N 次 UI 重绘

每条 `Add` 都触发一次 `CollectionChanged`，绑定到 `ItemsControl` 时会导致 N 次布局和渲染。
大数据量时应批量替换：

```csharp
// 错误：10000 条数据触发 10000 次 UI 更新
foreach (var item in loadedItems)
    Items.Add(item);

// 正确：一次性替换，只触发 1 次 UI 更新
Items = new BindableCollection<Item>(loadedItems);
NotifyOfPropertyChange(nameof(Items));
```

> Stylet 的 `BindableCollection<T>` 继承自 `ObservableCollection<T>`，
> 并添加了 `AddRange` 方法（只触发一次通知）。大数据量场景优先使用：
> ```csharp
> Items.AddRange(loadedItems); // 只触发 1 次 CollectionChanged
> ```

#### 2. 在 Guard Property (CanXxx) 的 getter 中做耗时计算

Stylet 每次检查按钮状态都会读取 `CanXxx` 属性。如果 getter 中包含耗时逻辑，
UI 线程会在按钮状态检查时卡顿：

```csharp
// 错误：每次按钮状态刷新都执行耗时检查
public bool CanSave => ValidateEntireForm() && HasChanges && !IsUploading;

// 正确：将结果缓存为字段，在相关属性变化时更新
private bool _canSave;
public bool CanSave
{
    get => _canSave;
    private set => SetAndNotify(ref _canSave, value);
}

// 在表单内容变化时更新 CanSave
private void UpdateCanSave()
{
    CanSave = ValidateEntireForm() && HasChanges && !IsUploading;
}
```

#### 3. PropertyChanged 通知风暴

一个属性变化级联触发大量关联属性通知，导致 WPF 布局引擎反复执行：

```csharp
// 错误：设置一个属性触发 10+ 个关联通知
public string RawData
{
    get => _rawData;
    set
    {
        SetAndNotify(ref _rawData, value);
        // 每个 NotifyOfPropertyChange 都触发 UI 刷新
        NotifyOfPropertyChange(nameof(Field1));
        NotifyOfPropertyChange(nameof(Field2));
        // ...NotifyOfPropertyChange(nameof(Field10));
    }
}

// 正确：批量更新后用 string.Empty 一次性通知所有属性
public string RawData
{
    get => _rawData;
    set
    {
        SetAndNotify(ref _rawData, value);
        // 空字符串通知 = 告诉 WPF "所有属性都可能变了"，只触发 1 次布局
        NotifyOfPropertyChange(string.Empty);
    }
}
```

#### 4. Dispatcher.Invoke 导致跨线程死锁

后台线程使用 `Dispatcher.Invoke`（同步等待）而非 `Dispatcher.BeginInvoke`（异步投递），
如果 UI 线程也在等后台线程，就会死锁：

```csharp
// 危险：如果 UI 线程在 await 这个 Task，就会死锁
await Task.Run(() =>
{
    var result = HeavyComputation();
    Execute.OnUIThread(() => Status = result); // Invoke 语义，同步等待
});

// 安全：用 BeginInvoke 异步投递，不阻塞后台线程
await Task.Run(() =>
{
    var result = HeavyComputation();
    System.Windows.Application.Current.Dispatcher.BeginInvoke(
        new Action(() => Status = result));
});
```

### 内存泄漏

#### 5. 事件订阅未取消，ViewModel 永远不被 GC

在 `OnActivate` 中订阅了外部事件，但 `OnDeactivate`/`OnClose` 中未取消订阅。
被订阅方持有 ViewModel 的强引用，导致 ViewModel（及其 View、子 ViewModel）永远不被回收：

```csharp
public class MonitorViewModel : Screen
{
    private readonly ISystemService _service;

    protected override void OnActivate()
    {
        _service.StatusChanged += OnStatusChanged; // 订阅
    }

    protected override void OnDeactivate()
    {
        _service.StatusChanged -= OnStatusChanged; // 取消订阅！
    }

    private void OnStatusChanged(object sender, StatusEventArgs e)
    {
        Status = e.NewStatus;
    }
}
```

同样适用于：`EventAggregator` 的 `Unsubscribe`、`DispatcherTimer` 的 `Stop`、
`IDisposable` 资源的 `Dispose`。

#### 6. 定时器未在 OnClose 中停止

```csharp
public class LiveDashboardViewModel : Screen
{
    private DispatcherTimer _refreshTimer;

    protected override void OnViewLoaded()
    {
        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _refreshTimer.Tick += OnRefreshTick;
        _refreshTimer.Start();
    }

    protected override void OnClose()
    {
        // 必须停止定时器，否则它持有 ViewModel 引用，永远不会释放
        _refreshTimer?.Stop();
        if (_refreshTimer != null)
            _refreshTimer.Tick -= OnRefreshTick;
    }

    private void OnRefreshTick(object sender, EventArgs e)
    {
        // 刷新数据...
    }
}
```

#### 7. Conductor 中子 ViewModel 累积但未清理

选项卡应用中，如果只 `Items.Remove(vm)` 而不走 `CloseItem(vm)`，
子 ViewModel 不会被停用/关闭/释放，在内存中累积：

```csharp
// 错误：ViewModel 不释放，内存持续增长
Items.Remove(closedTab);

// 正确：走完整生命周期，自动释放
CloseItem(closedTab);
```

### CPU 飙高

#### 8. 计算属性放在 getter 中，每次绑定刷新都重算

WPF 每次读取绑定属性都会调用 getter。如果 getter 包含循环、LINQ、字符串拼接等，
CPU 会因频繁重算而飙高：

```csharp
// 错误：每次 UI 刷新都对 10000 条数据做 LINQ
public int ActiveCount => Items.Where(i => i.IsActive).Count();
public decimal TotalPrice => Items.Sum(i => i.Price * i.Quantity);

// 正确：缓存计算结果，在数据变化时更新
private int _activeCount;
public int ActiveCount
{
    get => _activeCount;
    private set => SetAndNotify(ref _activeCount, value);
}

private void Recalculate()
{
    ActiveCount = Items.Count(i => i.IsActive);
    TotalPrice = Items.Sum(i => i.Price * i.Quantity);
}
```

#### 9. BindableCollection/Items 在循环中反复触发通知

```csharp
// 错误：1000 次循环 = 1000 次 CollectionChanged = CPU 打满
for (int i = 0; i < 1000; i++)
    Items.Add(new Item(i));

// 正确：先构建集合，再一次性替换或 AddRange
var batch = Enumerable.Range(0, 1000).Select(i => new Item(i)).ToList();
Items.AddRange(batch);
```

#### 10. Conductor.Collection.AllActive 大量子 ViewModel 同时激活

`AllActive` 会同时激活所有子 ViewModel（都调用 `OnActivate`）。
如果子 ViewModel 的 `OnActivate` 包含耗时操作或定时器，N 个子项 = N 倍 CPU 开销。
只在确实需要同时显示的场景使用，否则改用 `OneActive`。

### 性能检查清单

在提交代码前，对照以下检查项：

- [ ] `ObservableCollection` / `BindableCollection` 的批量操作是否用了 `AddRange` 或整体替换？
- [ ] `CanXxx` Guard 属性的 getter 是否只返回缓存字段？
- [ ] `OnActivate` / `OnViewLoaded` 中是否有同步耗时操作？
- [ ] 所有 `+=` 事件订阅是否有对应的 `-=` 取消？
- [ ] `DispatcherTimer` / `Timer` 是否在 `OnClose` 中 `Stop` + 取消事件？
- [ ] 后台线程更新 UI 属性是否通过 `Execute.OnUIThread` 调度？
- [ ] 计算属性的结果是否缓存，而非每次 getter 重算？
- [ ] `Conductor` 关闭子项是否用 `CloseItem` 而非直接 `Remove`？

---

## 最佳实践

### 项目结构

```
MyApp/
├── App.xaml          # ApplicationLoader + Bootstrapper 引用
├── Bootstrapper.cs   # IoC 配置、启动逻辑
├── Models/           # 纯数据模型（不依赖 Stylet）
├── Services/         # 业务服务接口和实现
├── ViewModels/       # ShellViewModel, HomeViewModel, ...
├── Views/            # ShellView.xaml, HomeView.xaml, ...（与 ViewModel 一一对应）
└── Converters/       # 值转换器
```

### 设计原则

- **ViewModel 不引用 View 类型**：只通过 `IWindowManager` 打开窗口
- **每个 Screen 职责单一**：一个 Screen 对应一个功能页面或对话框
- **用 Conductor 管理导航**：不要手动切换 `DataContext`
- **Guard Property 与 Action 配对**：每个公开 Action 方法都应有对应的 `CanXxx`
- **对话框 ViewModel 继承 Screen**：通过 `RequestClose(true/false)` 返回结果

### 命名约定（补充）

View/ViewModel 命名见上文"命名约定"表。以下为本节补充：

| 类型 | 命名规则 | 示例 |
|------|----------|------|
| Guard 属性 | `Can{方法名}` | `CanSave` |
| Action 方法 | 动词开头 | `Save`, `DeleteItem`, `OpenSettings` |
| 私有字段 | `_camelCase` | `_userName` |

### 测试友好设计

- ViewModel 依赖通过构造函数注入接口，便于 Mock
- `IWindowManager` 可以在测试中 Mock，验证弹窗调用
- `Screen` 的生命周期方法可以手动调用进行测试（`Activate`/`Deactivate`/`Close`）
- 不要在 ViewModel 中直接使用 `MessageBox`，封装为 `IDialogService` 接口

```csharp
public interface IDialogService
{
    Task<bool> ConfirmAsync(string title, string message);
    Task<string?> InputAsync(string title, string prompt);
}
```

### 与 PropertyChanged.Fody 配合

如果项目使用了 `PropertyChanged.Fody`（编译时自动注入 PropertyChanged 通知），
仍需继承 `PropertyChangedBase` 或 `Screen`，但不需要手动调用 `SetAndNotify`：

```csharp
// 使用 Fody 时，属性会自动触发通知
public class UserViewModel : Screen
{
    public string Name { get; set; }    // Fody 自动注入
    public int Age { get; set; }        // Fody 自动注入
    public string DisplayText => $"{Name} ({Age})"; // Fody 自动关联依赖
}
```

---

## 参考资源

- Stylet GitHub 仓库：<https://github.com/canton7/Stylet>
- Stylet Wiki 文档：<https://github.com/canton7/Stylet/wiki>
- Stylet NuGet 包：<https://www.nuget.org/packages/Stylet/>
- Stylet Templates：`dotnet new install Stylet.Templates`
