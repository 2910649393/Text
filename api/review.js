const fetch = require("node-fetch");
const FormData = require("form-data");

// Kimi API 基础 URL
const KIMI_API_BASE = "https://api.moonshot.cn/v1";

// 构建系统提示词
function buildSystemPrompt(dimensions) {
  const dims = (dimensions || "").split(",").map((d) => d.trim()).filter(Boolean);

  const dimLabels = {
    计算错误: "任务一：数据计算错误审查",
    附注一致性: "任务二：主表与附注一致性审查",
    标点格式: "任务三：标点符号与格式错误审查",
  };

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

// 删除文件（最佳实践，审查完成后清理）
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
    // 保留最后一个可能不完整的行
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") {
        return;
      }

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

// 主处理函数
module.exports = async function handler(req, res) {
  // CORS 头
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "仅支持 POST 请求" });
    return;
  }

  // Vercel Serverless Function 默认使用 bodyParser，需要处理 FormData
  // 对于文件上传，需要设置 bodyParser: false，但我们用 Vercel 的默认配置
  // 在 Vercel 中，api 目录下的函数默认 bodyParser 为 true
  // 我们需要在 vercel.json 中禁用 bodyParser 或者使用 raw body
  // 这里我们尝试从 req.body 和 req.files 中读取（Vercel 使用 busboy 解析）
  // 简化处理：检查是否是 FormData（通过 content-type 判断）
  const contentType = req.headers["content-type"] || "";

  let fileBuffer;
  let fileName = "report.pdf";
  let apiKey;
  let dimensions = "计算错误,附注一致性,标点格式";
  let streamMode = true;

  // 检查是否请求流式输出
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("stream") === "false") {
    streamMode = false;
  }

  try {
    if (contentType.includes("multipart/form-data")) {
      // Vercel 使用内置的 body parser 处理 multipart
      // 文件在 req.files 中，普通字段在 req.body 中
      if (req.files && req.files.file) {
        const file = req.files.file;
        // file 可能是数组或单个对象
        const f = Array.isArray(file) ? file[0] : file;
        fileBuffer = f.data || f.buffer;
        fileName = f.name || f.originalFilename || "report.pdf";
      }

      if (req.body) {
        if (req.body.apiKey) apiKey = req.body.apiKey;
        if (req.body.dimensions) dimensions = req.body.dimensions;
        if (req.body.stream !== undefined) {
          streamMode = req.body.stream === "true" || req.body.stream === true;
        }
      }
    } else if (contentType.includes("application/json")) {
      // JSON 模式（base64 编码的 PDF）
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (body.file) {
        fileBuffer = Buffer.from(body.file, "base64");
        fileName = body.fileName || "report.pdf";
      }
      if (body.apiKey) apiKey = body.apiKey;
      if (body.dimensions) dimensions = body.dimensions;
      if (body.stream !== undefined) {
        streamMode = body.stream === true || body.stream === "true";
      }
    } else {
      // 尝试直接从 req.body 读取（bodyParser 已解析的原始数据）
      if (req.body) {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        if (body.file) {
          fileBuffer = Buffer.from(body.file, "base64");
          fileName = body.fileName || "report.pdf";
        }
        if (body.apiKey) apiKey = body.apiKey;
        if (body.dimensions) dimensions = body.dimensions;
      }
    }
  } catch (parseErr) {
    // 如果 body 解析失败，回退到 raw body 处理
    // Vercel 默认 bodyParser 已解析，这里处理特殊情况
  }

  // 回退方案：使用环境变量中的 API Key
  if (!apiKey) {
    apiKey = process.env.MOONSHOT_API_KEY;
  }

  if (!apiKey) {
    res.status(400).json({ error: "缺少 API Key，请在前端输入或设置 MOONSHOT_API_KEY 环境变量" });
    return;
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    res.status(400).json({ error: "未收到有效的 PDF 文件" });
    return;
  }

  const systemPrompt = buildSystemPrompt(dimensions);

  if (streamMode) {
    // === SSE 流式输出模式 ===
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // 禁用 nginx 缓冲

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

      // 清理上传的文件
      if (fileId) {
        await deleteFile(apiKey, fileId);
      }
    } catch (err) {
      console.error("审查过程出错:", err);
      sendSSE(res, "error", { error: err.message || "未知错误" });
    } finally {
      res.end();
    }
  } else {
    // === 非流式模式（返回完整 JSON） ===
    let fileId = null;

    try {
      fileId = await uploadFileToKimi(apiKey, fileBuffer, fileName);
      const fileContent = await getFileContent(apiKey, fileId);

      // 非流式调用 Chat API
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

      // 清理上传的文件
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

      // 尝试清理文件
      if (fileId) {
        await deleteFile(apiKey, fileId).catch(() => {});
      }

      res.status(500).json({
        success: false,
        error: err.message || "未知错误",
      });
    }
  }
};

// 发送 SSE 事件
function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    // 连接可能已断开
  }
}