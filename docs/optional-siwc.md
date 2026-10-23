# 可选 ChatGPT 登录适配器

默认 API 路径不需要 SIWC。SIWC 是单独下载的 OpenAI Sign in with ChatGPT DevKit，安装目录为被 Git 忽略的 `vendor/siwc`；本仓库不分发 DevKit 源码、登录状态或凭据。

固定版本：`f723814abdccec135b519c451fb6e1992ee5e933`。

该版本采用 **Sign-In with ChatGPT DevKit Noncommercial License v1.0**，只授权非商业用途。商业使用需要上游另行书面许可；本框架的 MIT 许可证不覆盖它。

阅读 [固定版本官方许可证](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/f723814abdccec135b519c451fb6e1992ee5e933/LICENSE)，确认用途符合其条件后：

```sh
npm run bootstrap:siwc -- --accept-noncommercial-license
npm run credentials:create -- ./secrets/chatgpt-credential.key
```

在 `.env` 设置：

```dotenv
GATEWAY_PROVIDER=siwc
GATEWAY_CREDENTIAL_KEY_FILE=./secrets/chatgpt-credential.key
```

然后执行：

```sh
npm run auth:login
npm run auth:status
npm run runtime:models
```

默认下载需要访问官方 Git 仓库和 npm。账号资格、授权和模型能力以该组件及服务的实际要求为准。密钥必须与数据分开保管；不得提交到 Git。

本次框架验证不使用真实账号登录或向真实模型发送请求。若上游版本发生变化，升级前应重新核查许可和兼容性。
