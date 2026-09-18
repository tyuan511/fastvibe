import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const home = homedir();
const unitDir = resolve(home, ".config/systemd/user");
const unitPath = resolve(unitDir, "fastvibe-agent.service");
const template = readFileSync(resolve("resources/fastvibe-agent.service"), "utf8");
const agent = resolve("out/main/agent.js");
const unit = template.replace("@NODE@", process.execPath).replace("@AGENT@", agent);
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
writeFileSync(unitPath, unit, { mode: 0o600 });
chmodSync(unitPath, 0o600);
console.log(`已写入 ${unitPath}`);
console.log("SSH 鉴权由客户端配置决定，然后执行：");
console.log("systemctl --user daemon-reload && systemctl --user enable --now fastvibe-agent");
