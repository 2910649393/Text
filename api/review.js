const fetch = require("node-fetch");
const FormData = require("form-data");

// Kimi API 基础 URL
const KIMI_API_BASE = "https://api.moonshot.cn/v1";

// 构建系统提示词
function buildSystemPrompt(dimensions) {
  const dims = (dimensions || "").split(",").map((d) => d.trim()).filter(Boolean);

  const selectedTasks = [];
  if (dims.includes("计算错误") || dims.length === 0) selectedTasks.push("任务一");
  if (dims.includes("附注一致性") || dims.length === 0) selectedTasks.push("任务二");
  if (dims.includes("标点格式") || dims.length === 0) selectedTasks.push("任务三");
  // 如果没有任何匹配，默认全部
  if (selectedTasks.length === 0) selectedTasks.push("任务一", "任务二", "任务三");

  const taskInstruction = selectedTasks.length === 3
    ? "请完成全部三项任务。"
    : `请注意：用户仅选择了 ${selectedTasks.join("、")}，请只输出这些任务的审查结果，跳过来被选中的任务。`;

  return `你是一名具备注册会计师（CPA）资质的财务报告审查专家，同时精通中英文排版规范。现在请你对所提供的完整PDF财务报告（含全部附注、管理层讨论及补充信息）进行逐项审查，并严格按照以下三项任务输出最终结论。

【审查范围】
- 文件内容：完整的年度财务报告（含合并财务报表、附注、董事报告、审计报告、补充信息）。
- 重点关注：合并财务状况表（资产负债表）及其附注、全文标点符号与格式。

${taskInstruction}

【任务一：审查合并财务状况表各字段是否有数据计算错误】
1. 逐项验证"总资产"是否等于各资产科目加总（包含所有明细行）。
2. 逐项验证"总负债"是否等于各负债科目加总。
3. 逐项验证"总权益"是否等于各权益科目加总（注意股本、储备、累计亏损等正负号）。
4. 验证会计恒等式：总资产 = 总负债 + 总权益。
5. 验证"净流动资产/总资产"等派生指标（如有）是否基于上述数据正确计算。
6. 检查是否存在因四舍五入（千港元）导致的1-2单位差异，若存在需说明是否可接受。

【任务二：审查合并财务状况表与附注内容是否一致】
1. 将财务状况表中的每个资产、负债、权益科目金额，与对应附注中的"合计"金额逐项比对。
2. 检查附注中披露的明细加总是否等于附注总计，且该总计与财务状况表科目完全一致。
3. 检查附注中是否存在额外披露的金融工具未在财务状况表中列示，但应在表内确认的情况。
4. 检查附注中的重分类、期初余额调整等是否已正确反映在财务状况表中。

【任务三：审查整个文件是否存在标点符号和格式的错误】
1. 标点符号错误包括：中英文标点混用、多余反斜杠/转义符、数字分隔符错误、括号引号不匹配、英文连字符缺失或多余、日期格式不统一、缩写首次出现未定义、重复的句子或段落。
2. 格式错误包括：表格线条缺失或合并单元格错位、数字未按小数点对齐、标题编号重复或跳号、页眉页脚信息错乱、字体不一致、段落缩进不统一或换行异常、表格跨页断开后未重印表头、图表编号与引用不符。

【输出要求】
每项结论必须明确打"✅"或"❌"，并附具体证据说明。所有金额必须带单位（千港元），注明年份。最终输出需简洁明了，只给出结论和关键证据。`;
}

// 上传文件到 Kimi Files API
async function uploadFileToKimi(apiKey, fileBuffer, fileName) {
  const formData = new FormData();
  formData.append("purpose", "file-extract");
  formData.append("file", fileBuffer, {
    filename: fileName || "report.pdf",
    contentType: "application/pdf",
  });

  const response = await fetch(`${KIMI_API_BASE}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi Files API 上传失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.id;
}

// 获取文件内容
async function getFileContent(apiKey, fileId) {
  const response = await fetch(`${KIMI_API_BASE}/files/${fileId}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi Files Content API 获取失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.content;
}

// 删除文件（审查完成后清理）
async function deleteFile(apiKey, fileId) {
  try {
    await fetch(`${KIMI_API_BASE}/files/${fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (_) {
    // 删除失败不影响主流程
  }
}

// 流式调用 Chat Completions API
async function* streamChatCompletions(apiKey, systemPrompt, fileContent) {
  const response = await fetch(`${KIMI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "kimi-k2-turbo-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `请审查以下财务报告：\n\n${fileContent}` },
      ],
      stream: true,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi Chat API 调用失败 (${response.status}): ${errorText}`);
  }

  // 逐行读取 SSE 流
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") return;

      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          yield { type: "content", content: delta.content };
        }
      } catch (_) {
        // 跳过无法解析的行
      }
    }
  }

  // 处理 buffer 中剩余的内容
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data:")) {
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr !== "[DONE]") {
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: "content", content: delta.content };
          }
        } catch (_) { /* ignore */ }
      }
    }
  }
}

// 读取 HTTP 请求的完整 raw body
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 主处理函数
const handler = async function (req, res) {
  // CORS 头
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Dimensions, X-File-Name");
  res.setHeader("Access-Control-Expose-Headers", "*");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "仅支持 POST 请求" });
    return;
  }

  const contentType = (req.headers["content-type"] || "").toLowerCase();

  // ==================== 解析参数 ====================
  // 方案 1：从自定义 Header 读取（推荐，最可靠）
  let apiKey = req.headers["x-api-key"] || "";
  let dimensions = req.headers["x-dimensions"] || "计算错误,附注一致性,标点格式";
  let fileName = req.headers["x-file-name"] || "report.pdf";
  let streamMode = true;

  try {
    // 1. 读取 raw body
    const rawBody = await readRawBody(req);

    let fileBuffer = null;

    // 2. 根据 Content-Type 判断如何解析
    if (contentType.includes("application/pdf") || contentType.includes("application/octet-stream")) {
      // PDF 作为 raw binary body 发送
      fileBuffer = rawBody;
      if (!apiKey) {
        // 再次尝试从 raw body 中解析（可能是 multipart 回退）
        // 不做额外处理，Header 应该是主要来源
      }
    } else if (contentType.includes("multipart/form-data")) {
      // multipart/form-data 回退方案（兼容旧版）
      const boundary = contentType.split("boundary=")[1];
      if (boundary) {
        const parsed = parseMultipartFormData(rawBody, boundary);
        if (parsed.fields.apiKey) apiKey = apiKey || parsed.fields.apiKey;
        if (parsed.fields.dimensions) dimensions = dimensions || parsed.fields.dimensions;
        if (parsed.fields.stream !== undefined) {
          streamMode = parsed.fields.stream === "true" || parsed.fields.stream === true;
        }
        if (parsed.files.file) {
          fileBuffer = parsed.files.file.data;
          fileName = parsed.files.file.filename || fileName;
        }
      }
    } else if (contentType.includes("application/json")) {
      // JSON base64 回退方案
      try {
        const json = JSON.parse(rawBody.toString("utf-8"));
        if (json.file) {
          fileBuffer = Buffer.from(json.file, "base64");
          fileName = json.fileName || fileName;
        }
        if (json.apiKey) apiKey = apiKey || json.apiKey;
        if (json.dimensions) dimensions = dimensions || json.dimensions;
        if (json.stream !== undefined) streamMode = json.stream === true || json.stream === "true";
      } catch (e) {
        // JSON 解析失败，可能是 bodyParser 已经处理过的对象（Vercel 默认行为）
        // rawBody 实际上是 Vercel 已经解析过的 JSON 对象序列化后的结果
        // 在这种情境下，fileBuffer 仍为 null，会在后面报错
      }
    } else {
      // 未知 Content-Type：尝试作为 JSON 解析
      // Vercel 默认 bodyParser 可能会将 req.body 设置为解析后的对象
      // 但因为我们禁用了 bodyParser，这里的 rawBody 就是原始数据
      try {
        const text = rawBody.toString("utf-8");
        if (text.startsWith("{") || text.startsWith("[")) {
          const json = JSON.parse(text);
          if (json.file) {
            fileBuffer = Buffer.from(json.file, "base64");
            fileName = json.fileName || fileName;
          }
          if (json.apiKey) apiKey = apiKey || json.apiKey;
          if (json.dimensions) dimensions = dimensions || json.dimensions;
        } else if (text.startsWith("sk-")) {
          // 看起来像是 API Key 被误当作了 body
          apiKey = apiKey || text.trim();
        }
      } catch (e) {
        // 最后的回退：把整个 raw body 当作 PDF 文件内容
        if (rawBody.length > 0) {
          fileBuffer = rawBody;
          // 通过魔数检查是否是 PDF
          if (rawBody[0] === 0x25 && rawBody[1] === 0x50) {
            // 是合法的 PDF (以 %PDF 开头)
          }
        }
      }
    }

    // 3. 环境变量兜底
    if (!apiKey) {
      apiKey = process.env.MOONSHOT_API_KEY || "";
    }

    // ==================== 参数校验 ====================
    if (!apiKey) {
      res.status(400).json({
        error: "缺少 API Key，请在前端输入 API Key 或设置 MOONSHOT_API_KEY 环境变量",
        hint: "请通过 X-API-Key 请求头或在请求体中传递 apiKey 参数",
      });
      return;
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      res.status(400).json({
        error: "未收到有效的 PDF 文件",
        hint: "请将 PDF 文件作为请求 body（Content-Type: application/pdf）发送，或使用 multipart/form-data 格式",
        receivedContentType: contentType,
        bodySize: rawBody.length,
      });
      return;
    }

    // ==================== 执行审查 ====================
    const systemPrompt = buildSystemPrompt(dimensions);

    if (streamMode) {
      // === SSE 流式输出模式 ===
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      let fileId = null;

      try {
        // 阶段 1：上传 PDF
        sendSSE(res, "stage", { stage: "upload", message: "正在上传 PDF 文件..." });
        fileId = await uploadFileToKimi(apiKey, fileBuffer, fileName);
        sendSSE(res, "stage", { stage: "upload_done", message: "PDF 上传完成", fileId });

        // 阶段 2：提取文本内容
        sendSSE(res, "stage", { stage: "extract", message: "正在提取 PDF 文本内容..." });
        const fileContent = await getFileContent(apiKey, fileId);
        sendSSE(res, "stage", {
          stage: "extract_done",
          message: `文本内容提取完成（${fileContent.length} 字符）`,
          contentLength: fileContent.length,
        });

        // 阶段 3：AI 审查
        sendSSE(res, "stage", { stage: "review", message: "AI 正在审查报告..." });

        const stream = streamChatCompletions(apiKey, systemPrompt, fileContent);
        for await (const event of stream) {
          sendSSE(res, "content", { content: event.content });
        }

        // 完成
        sendSSE(res, "done", { message: "审查完成" });
      } catch (err) {
        console.error("审查过程出错:", err);
        sendSSE(res, "error", { error: err.message || "未知错误" });
      } finally {
        if (fileId) {
          await deleteFile(apiKey, fileId);
        }
        res.end();
      }
    } else {
      // === 非流式模式 ===
      let fileId = null;

      try {
        fileId = await uploadFileToKimi(apiKey, fileBuffer, fileName);
        const fileContent = await getFileContent(apiKey, fileId);

        const chatResponse = await fetch(`${KIMI_API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "kimi-k2-turbo-preview",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `请审查以下财务报告：\n\n${fileContent}` },
            ],
            stream: false,
            temperature: 0.3,
          }),
        });

        if (!chatResponse.ok) {
          const errorText = await chatResponse.text();
          throw new Error(`Kimi Chat API 调用失败 (${chatResponse.status}): ${errorText}`);
        }

        const chatData = await chatResponse.json();
        const reviewContent = chatData.choices?.[0]?.message?.content || "";

        if (fileId) {
          await deleteFile(apiKey, fileId);
        }

        res.status(200).json({
          success: true,
          content: reviewContent,
          contentLength: fileContent.length,
        });
      } catch (err) {
        console.error("审查过程出错:", err);

        if (fileId) {
          await deleteFile(apiKey, fileId).catch(() => {});
        }

        res.status(500).json({
          success: false,
          error: err.message || "未知错误",
        });
      }
    }
  } catch (err) {
    console.error("请求处理出错:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: `服务器内部错误: ${err.message}` });
    }
  }
};

// ==================== 辅助函数：手动解析 multipart/form-data ====================
function parseMultipartFormData(buffer, boundary) {
  const fields = {};
  const files = {};

  // 边界分隔符
  const delimiter = Buffer.from(`--${boundary}`);
  const closeDelimiter = Buffer.from(`--${boundary}--`);
  const newline = Buffer.from("\r\n");
  const doubleNewline = Buffer.from("\r\n\r\n");

  // 按边界切分
  let start = 0;
  const parts = [];

  while (start < buffer.length) {
    const idx = buffer.indexOf(delimiter, start);
    if (idx === -1) break;
    start = idx + delimiter.length;

    // 跳过开头的换行
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const nextDelim = buffer.indexOf(delimiter, start);
    if (nextDelim === -1) break;

    let partEnd = nextDelim - 2; // 去掉分隔符前的 \r\n
    if (partEnd > start && buffer[partEnd] === 0x0a && partEnd > 0 && buffer[partEnd - 1] === 0x0d) {
      partEnd -= 2;
    }

    parts.push(buffer.slice(start, partEnd));
    start = nextDelim;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf(doubleNewline);
    if (headerEnd === -1) continue;

    const headerSection = part.slice(0, headerEnd).toString("utf-8");
    const body = part.slice(headerEnd + doubleNewline.length);

    // 解析 Content-Disposition
    const cdMatch = headerSection.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!cdMatch) continue;

    const fieldName = cdMatch[1];
    const filename = cdMatch[2];

    if (filename) {
      files[fieldName] = {
        filename: filename,
        data: body,
      };
    } else {
      fields[fieldName] = body.toString("utf-8").trim();
    }
  }

  return { fields, files };
}

// 发送 SSE 事件
function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    // 连接可能已断开
  }
}

// 导出 handler（CommonJS），同时设置 bodyParser: false 以手动处理 raw body
module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
