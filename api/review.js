const fetch = require("node-fetch");

// 不再需要 FormData（不再上传文件到 Kimi Files API）

// Kimi API 基础 URL
const KIMI_API_BASE = "https://api.moonshot.cn/v1";

// ==================== 工具函数 ====================

function decodeURIComponentSafe(str) {
  if (!str) return "";
  try { return decodeURIComponent(str); } catch (_) { return str; }
}

function sendJSON(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* 连接可能已断开 */ }
}

// ==================== 系统提示词 ====================

function buildSystemPrompt(dimensions) {
  const dims = (dimensions || "").split(",").map((d) => d.trim()).filter(Boolean);

  const selectedTasks = [];
  if (dims.includes("计算错误") || dims.length === 0) selectedTasks.push("任务一");
  if (dims.includes("附注一致性") || dims.length === 0) selectedTasks.push("任务二");
  if (dims.includes("标点格式") || dims.length === 0) selectedTasks.push("任务三");
  if (selectedTasks.length === 0) selectedTasks.push("任务一", "任务二", "任务三");

  const taskInstruction = selectedTasks.length === 3
    ? "请完成全部三项任务。"
    : `请注意：用户仅选择了 ${selectedTasks.join("、")}，请只输出这些任务的审查结果，跳过未被选中的任务。`;

  return `你是一名具备注册会计师（CPA）资质的财务报告审查专家，同时精通中英文排版规范。现在请你对所提供的PDF财务报告图片（含全部附注、管理层讨论及补充信息）进行逐页审查，并严格按照以下三项任务输出最终结论。

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

// ==================== Kimi 视觉 Chat API ====================

async function* streamVisionChat(apiKey, systemPrompt, images, totalPages, maxImages) {
  // 构建 user content 数组
  const userContent = [];

  // 文本说明
  let introText = "请严格按系统提示词中的要求，审查以下PDF财务报告的每一页内容：";
  if (images.length < totalPages) {
    introText = `由于页数限制（最多${maxImages}页），仅审查了前${images.length}页（共${totalPages}页）。请基于这${images.length}页进行审查：`;
  }
  userContent.push({ type: "text", text: introText });

  // 逐页添加图片
  for (let i = 0; i < images.length; i++) {
    userContent.push({
      type: "image_url",
      image_url: { url: images[i] },
    });
  }

  const response = await fetch(`${KIMI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "kimi-k2.6",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
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
      } catch (_) { /* skip */ }
    }
  }

  // 处理缓冲区中剩余的内容
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim());
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          yield { type: "content", content: delta.content };
        }
      } catch (_) { /* ignore */ }
    }
  }
}

// ==================== 主处理函数 ====================

const handler = async function (req, res) {
  // CORS 头
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Dimensions, X-File-Name, X-Total-Pages");
  res.setHeader("Access-Control-Expose-Headers", "*");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "仅支持 POST 请求" });
    return;
  }

  const contentType = (req.headers["content-type"] || "").toLowerCase();

  // ==================== 解析参数 ====================
  let apiKey = req.headers["x-api-key"] || "";
  let dimensions = decodeURIComponentSafe(req.headers["x-dimensions"]) || "计算错误,附注一致性,标点格式";
  let totalPages = parseInt(req.headers["x-total-pages"] || "0", 10);

  const MAX_IMAGES = 20; // Kimi k2.6 单次最多约 20 张图
  const MAX_SINGLE_IMAGE_SIZE = 10 * 1024 * 1024; // 单张 base64 不超过 ~10MB

  try {
    const rawBody = await readRawBody(req);
    let images = [];

    // 解析 JSON body
    if (rawBody.length > 0) {
      try {
        const json = JSON.parse(rawBody.toString("utf-8"));
        if (json.images && Array.isArray(json.images)) {
          images = json.images;
        }
        if (json.apiKey) apiKey = apiKey || json.apiKey;
        if (json.dimensions) dimensions = dimensions || json.dimensions;
        if (json.totalPages) totalPages = totalPages || json.totalPages;
      } catch (e) {
        // 如果 JSON 解析失败，尝试从 Header 获取（兼容旧版 raw binary）
        // 但新版不需要这个回退了，直接报错
      }
    }

    // 环境变量兜底
    if (!apiKey) {
      apiKey = process.env.MOONSHOT_API_KEY || "";
    }

    // ==================== 参数校验 ====================
    if (!apiKey) {
      sendJSON(res, 400, {
        error: "缺少 API Key，请在前端输入 API Key 或设置 MOONSHOT_API_KEY 环境变量",
      });
      return;
    }

    if (!images || images.length === 0) {
      sendJSON(res, 400, {
        error: "未收到有效的 PDF 页面图片",
        hint: "请将 PDF 各页渲染为 base64 图片后通过 JSON body 的 images 数组发送",
      });
      return;
    }

    // 图片数量限制
    let finalImages = images;
    if (finalImages.length > MAX_IMAGES) {
      finalImages = finalImages.slice(0, MAX_IMAGES);
    }

    // ==================== 执行审查 ====================
    const systemPrompt = buildSystemPrompt(dimensions);

    // SSE 流式输出
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    try {
      sendSSE(res, "stage", {
        stage: "review",
        message: `正在使用 Kimi 视觉模型分析 ${finalImages.length} 页财务报告...`,
        pageCount: finalImages.length,
      });

      const stream = streamVisionChat(apiKey, systemPrompt, finalImages, totalPages || images.length, MAX_IMAGES);
      for await (const event of stream) {
        sendSSE(res, "content", { content: event.content });
      }

      sendSSE(res, "done", { message: "审查完成" });
    } catch (err) {
      console.error("审查过程出错:", err);

      // 检查是否是 token 超限错误
      let errorMsg = err.message || "未知错误";
      if (errorMsg.includes("token") || errorMsg.includes("context length") || errorMsg.includes("too long")) {
        errorMsg = "图片内容过大，超出模型处理能力。建议减少 PDF 页数或降低图片质量后重试。" + " 原始错误: " + errorMsg;
      }

      sendSSE(res, "error", { error: errorMsg });
    } finally {
      res.end();
    }
  } catch (err) {
    console.error("请求处理出错:", err);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: `服务器内部错误: ${err.message}` });
    }
  }
};

// ==================== 导出 ====================
module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};