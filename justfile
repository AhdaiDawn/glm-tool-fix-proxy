set shell := ["zsh", "-lc"]

port := env_var_or_default("PORT", "3401")
host := env_var_or_default("HOST", "127.0.0.1")
upstream := env_var_or_default("UPSTREAM_BASE_URL", "http://115.120.82.129:3000/v1")
upstream_model := env_var_or_default("UPSTREAM_MODEL", "glm-5")
upstream_max_tokens := env_var_or_default("UPSTREAM_MAX_TOKENS", "8192")

default:
  @just --list

start:
  PORT={{port}} HOST={{host}} UPSTREAM_BASE_URL={{upstream}} UPSTREAM_MODEL={{upstream_model}} UPSTREAM_MAX_TOKENS={{upstream_max_tokens}} node server.mjs

test:
  npm test

check:
  node --check server.mjs
  node --check repair.mjs

curl-chat:
  curl -sS http://{{host}}:{{port}}/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $UPSTREAM_API_KEY" \
    -d '{"model":"glm-5","messages":[{"role":"user","content":"请简短介绍一下这个代理的作用。"}],"stream":false}'

curl-stream:
  curl -sS -N http://{{host}}:{{port}}/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $UPSTREAM_API_KEY" \
    -d '{"model":"glm-5","messages":[{"role":"user","content":"请调用read工具读取 /home/ahdai/.config/opencode/opencode.json"}],"tools":[{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"]}}}],"tool_choice":"auto","stream":true}'

curl-messages:
  curl -sS http://{{host}}:{{port}}/v1/messages \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $UPSTREAM_API_KEY" \
    -d '{"model":"glm-5","max_tokens":512,"messages":[{"role":"user","content":[{"type":"text","text":"请调用read工具读取 /home/ahdai/.config/opencode/opencode.json"}]}],"tools":[{"name":"read","description":"Read a file","input_schema":{"type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"]}}]}'

curl-responses:
  curl -sS http://{{host}}:{{port}}/v1/responses \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $UPSTREAM_API_KEY" \
    -d '{"model":"glm-5","input":"请调用read工具读取 /home/ahdai/.config/opencode/opencode.json","tools":[{"type":"function","name":"read","description":"Read a file","parameters":{"type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"]}}]}'
