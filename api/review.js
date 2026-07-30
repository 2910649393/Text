const fetch = require("node-fetch");

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
  } catch (_) { /* 连接已断开 */ }
}

// ==================== 提示词 ====================

// 基础审查系统提示词（CPA 三任务）
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

  return `你是一名具备注册会计师（CPA）资质的财务报告审查专家，同时精通中英文排版规范。你正在审查一份PDF财务报告（含合并财务报表、附注、董事报告、审计报告、补充信息）。请严格按以下三项任务逐页审查并输出结论。

${taskInstruction}

【任务一：审查合并财务状况表各字段是否有数据计算错误】
1. 逐项验证"总资产"是否等于各资产科目加总。
2. 逐项验证"总负债"是否等于各负债科目加总。
3. 逐项验证"总权益"是否等于各权益科目加总。
4. 验证：总资产 = 总负债 + 总权益。
5. 验证"净流动资产/总资产"等派生指标是否计算正确。
6. 检查四舍五入（千港元）导致的1-2单位差异。

【任务二：审查合并财务状况表与附注内容是否一致】
1. 将财务状况表中的各科目金额与对应附注"合计"逐项比对。
2. 检查附注明细加总是否等于财务状况表对应科目。
3. 检查是否有金融工具在附注披露但未在表内列示。

【任务三：审查整个文件是否存在标点符号和格式的错误】
1. 标点：中英文标点混用、括号引号不匹配、连字符缺失/多余、日期格式不统一、重复句子段落。
2. 格式：表格线条缺失、数字未对齐、标题编号重复/跳号、字体不一致、换行异常。

【输出要求】
每项结论打"✅"或"❌"，附具体证据（金额带单位"千港元"）。只输出结论和关键证据，简洁明了。`;
}

// 汇总审查系统提示词
function buildSummaryPrompt() {
  return `你是一名具备注册会计师（CPA）资质的财务审查专家。以下是对一份多页财务报告分批次审查的结果汇总。请将这些分散的审查发现整合为一份统一的最终审查报告，按照以下结构组织：

### 📊 任务一：数据计算错误审查
（汇总各批次的计算错误发现，给出总体✅或❌结论）

### 🔗 任务二：主表与附注一致性审查
（汇总各批次的一致性发现，给出总体✅或❌结论）

### 📝 任务三：标点符号与格式错误审查
（汇总各批次的格式错误发现，给出总体✅或❌结论）

### 📋 最终结论
（三任务汇总，给出整体评价）

如果有跨批次的数据关联（如同一科目在多个批次中出现），请一并指出并验证一致性。`;
}

// ==================== 批次用户消息构建 ====================

function buildBatchUserContent(images, batchIndex, totalBatches) {
  const totalPages = totalBatches * images.length; // 估算
  const startPage = batchIndex * images.length + 1;
  const endPage = startPage + images.length - 1;

  let batchText;
  if (totalBatches === 1) {
    batchText = "请严格按系统提示词的要求，审查以下财务报告的每一页内容：";
  } else if (batchIndex === 0) {
    batchText = `这是财务报告的第 ${startPage}-${endPage} 页（第 ${batchIndex + 1}/${totalBatches} 批），请先审查这部分内容。请只输出本批次涉及的审查发现，最后不要写汇总结论。`;
  } else if (batchIndex === totalBatches - 1) {
    batchText = `这是财务报告的第 ${startPage}-${endPage} 页（最后一批，第 ${batchIndex + 1}/${totalBatches} 批）。请继续审查这部分内容，只输出本批次的新发现（不要重复之前已审查的内容）。审查完本批后，请给出针对本批次的三任务小结。`;
  } else {
    batchText = `这是财务报告的第 ${startPage}-${endPage} 页（第 ${batchIndex + 1}/${totalBatches} 批）。请继续审查这部分内容，只输出本批次的新发现，不要重复之前已审查的内容，也不要写最终汇总结论。`;
  }

  const userContent = [{ type: "text", text: batchText }];
  for (const img of images) {
    userContent.push({ type: "image_url", image_url: { url: img } });
  }
  return userContent;
}

// ==================== Kimi API 调用 ====================

async function* streamKimiChat(apiKey, model, messages, temperature = 0.3) {
  const response = await fetch(`${KIMI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true, temperature }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kimi Chat API 调用失败 (${response.status}): ${errorText}`);
  }

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
        if (delta?.content) yield { type: "content", content: delta.content };
      } catch (_) { /* skip */ }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim());
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) yield { type: "content", content: delta.content };
      } catch (_) { /* ignore */ }
    }
  }
}

// ==================== 主处理函数 ====================

const handler = async function (req, res) {
  // CORS 头
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Dimensions, X-Total-Pages");
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

  const MAX_IMAGES_PER_BATCH = 10;

  try {
    const rawBody = await readRawBody(req);
    if (rawBody.length === 0) {
      sendJSON(res, 400, { error: "请求体为空" });
      return;
    }

    const json = JSON.parse(rawBody.toString("utf-8"));

    // 解析参数
    let apiKey = req.headers["x-api-key"] || json.apiKey || process.env.MOONSHOT_API_KEY || "";
    let dimensions = decodeURIComponentSafe(req.headers["x-dimensions"]) || json.dimensions || "计算错误,附注一致性,标点格式";
    const summaryMode = json.summary === true;
    const batchResults = json.batchResults || [];
    const images = json.images || [];
    const batchIndex = json.batchIndex || 0;
    const totalBatches = json.totalBatches || 1;

    if (!apiKey) {
      sendJSON(res, 400, { error: "缺少 API Key" });
      return;
    }

    // ==================== 汇总模式 ====================
    if (summaryMode) {
      if (!batchResults || batchResults.length === 0) {
        sendJSON(res, 400, { error: "汇总模式缺少 batchResults" });
        return;
      }

      // SSE 流式输出
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      try {
        sendSSE(res, "stage", { stage: "summary", message: "正在生成最终汇总报告..." });

        const summaryContent = batchResults
          .map((r, i) => `## 第 ${i + 1} 批审查结果\n\n${r}`)
          .join("\n\n---\n\n");

        const stream = streamKimiChat(apiKey, "kimi-k2.6", [
          { role: "system", content: buildSummaryPrompt() },
          { role: "user", content: `请将以下${batchResults.length}批次的审查结果整合为一份统一的最终审查报告：\n\n${summaryContent}` },
        ]);

        for await (const event of stream) {
          sendSSE(res, "content", { content: event.content });
        }
        sendSSE(res, "done", { message: "汇总完成" });
      } catch (err) {
        console.error("汇总出错:", err);
        let errMsg = err.message || "未知错误";
        if (errMsg.includes("token") || errMsg.includes("context length") || errMsg.includes("too long")) {
          errMsg = "批次结果过多，超出模型处理能力。建议减少总批次数。" + " " + errMsg;
        }
        sendSSE(res, "error", { error: errMsg });
      } finally {
        res.end();
      }
      return;
    }

    // ==================== 普通批次审查模式 ====================
    if (!images || images.length === 0) {
      sendJSON(res, 400, { error: "未收到有效的 PDF 页面图片" });
      return;
    }

    let finalImages = images;
    if (finalImages.length > MAX_IMAGES_PER_BATCH) {
      finalImages = finalImages.slice(0, MAX_IMAGES_PER_BATCH);
    }

    // SSE 流式输出
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    try {
      sendSSE(res, "stage", {
        stage: "review",
        message: `正在审查第 ${batchIndex + 1}/${totalBatches} 批（${finalImages.length} 页）...`,
        batchIndex,
        totalBatches,
        pageCount: finalImages.length,
      });

      const systemPrompt = buildSystemPrompt(dimensions);
      const userContent = buildBatchUserContent(finalImages, batchIndex, totalBatches);

      const stream = streamKimiChat(apiKey, "kimi-k2.6", [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ]);

      for await (const event of stream) {
        sendSSE(res, "content", { content: event.content });
      }

      sendSSE(res, "done", {
        message: `第 ${batchIndex + 1}/${totalBatches} 批审查完成`,
        batchIndex,
        totalBatches,
      });
    } catch (err) {
      console.error(`批次 ${batchIndex} 审查出错:`, err);
      let errMsg = err.message || "未知错误";
      if (errMsg.includes("token") || errMsg.includes("context length")) {
        errMsg = `批次图片过大，超出模型处理能力。${errMsg}`;
      }
      sendSSE(res, "error", { error: errMsg, batchIndex });
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
module.exports.config = { api: { bodyParser: false } };