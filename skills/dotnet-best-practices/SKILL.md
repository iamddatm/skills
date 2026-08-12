---
name: dotnet-best-practices
description: '确保 .NET/C# 代码符合解决方案/项目的最佳实践规范。'
---

# .NET/C# 最佳实践

你的任务是确保 ${selection} 中的 .NET/C# 代码符合本解决方案/项目的最佳实践。具体包括：

## 文档与结构

- 为所有公开的类、接口、方法和属性创建完整的 XML 文档注释
- XML 注释中需包含参数说明和返回值说明
- 遵循既定的命名空间结构：{Core|Console|App|Service}.{Feature}

## 设计模式与架构

- 使用主构造函数语法进行依赖注入（例如 `public class MyClass(IDependency dependency)`）
- 使用泛型基类实现命令处理程序模式（例如 `CommandHandler<TOptions>`）
- 遵循接口隔离原则，使用清晰的命名约定（接口名称以 'I' 为前缀）
- 对复杂对象的创建使用工厂模式

## 依赖注入与服务

- 使用构造函数依赖注入，并通过 ArgumentNullException 进行空值检查
- 以合适的生命周期注册服务（Singleton、Scoped、Transient）
- 使用 Microsoft.Extensions.DependencyInjection 模式
- 实现服务接口以提高可测试性
- 通过 IHttpClientFactory 管理 HttpClient 生命周期（防止 socket 耗尽）；无 DI 场景使用静态或单例 HttpClient，避免在业务代码中直接实例化

## 资源管理与本地化

- 使用 ResourceManager 管理本地化的消息和错误字符串
- 将 LogMessages 和 ErrorMessages 分别存放在独立的资源文件中
- 通过 `_resourceManager.GetString("MessageKey")` 访问资源

## 异步编程模式

- 对所有 I/O 操作和长时间运行的任务使用 async/await
- 异步方法返回 Task 或 Task<T>
- 在适当场景使用 ConfigureAwait(false)
- 正确处理异步异常

## 测试规范

- 使用 MSTest 框架配合 FluentAssertions 进行断言
- 遵循 AAA 模式（Arrange、Act、Assert）
- 使用 Moq 模拟依赖
- 同时测试成功和失败场景
- 包含空参数验证测试

## 配置与设置

- 使用带数据注解的强类型配置类
- 实现验证特性（Required、NotEmptyOrWhitespace）
- 使用 IConfiguration 绑定设置
- 支持 appsettings.json 配置文件

## Semantic Kernel 与 AI 集成

- 使用 Microsoft.SemanticKernel 进行 AI 操作
- 实现正确的内核配置和服务注册
- 处理 AI 模型设置（ChatCompletion、Embedding 等）
- 使用结构化输出模式确保 AI 响应的可靠性

## 错误处理与日志

- 使用 Microsoft.Extensions.Logging 进行结构化日志记录
- 包含带有意义上下文的范围日志
- 抛出带有描述性信息的特定异常
- 对可预见的失败场景使用 try-catch 块

## 性能与安全

- 在适用场景使用 C# 12+ 和 .NET 8+ 特性进行优化
- 实现正确的输入验证和清理
- 数据库操作使用参数化查询
- 遵循 AI/ML 操作的安全编码规范

## 代码质量

- 确保符合 SOLID 原则
- 通过基类和工具类避免代码重复
- 使用反映领域概念的有意义的命名
- 保持方法职责单一且内聚
- 实现正确的资源释放模式
