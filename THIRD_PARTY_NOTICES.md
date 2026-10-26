# Third-party components

The MIT license in this repository covers its framework source. Dependencies and optional integrations retain their own licenses and service terms.

| Direct dependency | Locked version | License |
| --- | --- | --- |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| openai | 7.31.0 | Apache-2.0 |
| qrcode | 1.5.4 | MIT |
| silk-wasm | 3.7.1 | MIT |
| ws | 8.22.0 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| tsx and @types packages | See package-lock.json | MIT |

The lockfile records transitive dependency versions and license identifiers. Installed package distributions include their respective license files; retain relevant licenses and notices when redistributing dependencies or bundles.

Optional Sign in with ChatGPT DevKit is **not included** in this source distribution. The pinned revision has a noncommercial license, separate from this repository's MIT license. See [optional SIWC](docs/optional-siwc.md) and its [upstream license](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/f723814abdccec135b519c451fb6e1992ee5e933/LICENSE).

Provider SDK source license does not grant service access, account eligibility, or rights to paid API usage.


## cloudflared（可选下载）

启用 Cloudflare 临时控制中心访问时可自动下载 Cloudflare 官方发布的 cloudflared。本仓库不包含其二进制；下载清单固定发布版本、文件大小和官方 SHA-256，见 `scripts/host/cloudflared-release.json`。cloudflared 由 Cloudflare 维护，采用 Apache-2.0 许可；源码与许可见 https://github.com/cloudflare/cloudflared 。手动安装的版本优先复用，Cloudflare 服务本身遵循其服务条款。
