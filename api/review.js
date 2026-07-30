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

// 分组汇总 prompt（只做结构化，不给结论）
function buildGroupSummaryPrompt(groupNum, totalGroups) {
  const half = groupNum === 1 ? "前" : "后";
  return `你是一名具备注册会计师（CPA）资质的财务报告审查专家。以下是对一份财务报告${half}半部分的分批审查结果。请将这些发现按【任务一：数据计算错误】【任务二：主表附注一致性】【任务三：标点格式错误】三个维度整理为结构化的中间汇总报告。

要求：
- 每条发现保留原文证据，不要丢失细节
- 所有金额带单位（千港元）
- 不要给出最终结论（由后续步骤完成）
- 输出简洁，每条发现打✅或❌`;
}

// 最终合并 prompt
function buildFinalMergePrompt() {
  return `你是一名具备注册会计师（CPA）资质的财务报告审查专家。以下是对一份完整财务报告的两份中间汇总结果（分别覆盖前半部分和后半部分）。请将所有发现整合为一份统一的最终审查报告，严格按以下结构输出：

### 📊 任务一：数据计算错误审查
（逐项列出发现，每条打✅或❌）

### 🔗 任务二：主表与附注一致性审查
（逐项列出发现，每条打✅或❌）

### 📝 任务三：标点符号与格式错误审查
（逐项列出发现，每条打✅或❌）

### 📋 最终结论
- 如果某任务所有项目均为✅，写"✅ 该任务无错误"
- 如果发现错误，写"❌ 该任务发现X处错误，详见上文"
- 所有金额带单位（千港元），注明年份

如有跨部分的数据关联请一并指出。`;
}

function buildBatchUserContent(images, batchIndex, totalBatches) {
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

async function* streamKimiChat(apiKey, model, messages, temperature = null) {
  const reqBody = { model, messages, stream: true };
  if (temperature !== null) reqBody.temperature = temperature;
  const response = await fetch(`${KIMI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(reqBody),
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Dimensions");
  res.setHeader("Access-Control-Expose-Headers", "*");

  if (req.method === "OPTIONS") { res.statusCode = 200; res.end(); return; }
  if (req.method !== "POST") { sendJSON(res, 405, { error: "仅支持 POST 请求" }); return; }

  const MAX_IMAGES_PER_BATCH = 10;

  try {
    const rawBody = await readRawBody(req);
    if (rawBody.length === 0) { sendJSON(res, 400, { error: "请求体为空" }); return; }
    const json = JSON.parse(rawBody.toString("utf-8"));

    let apiKey = req.headers["x-api-key"] || json.apiKey || process.env.MOONSHOT_API_KEY || "";
    let dimensions = decodeURIComponentSafe(req.headers["x-dimensions"]) || json.dimensions || "计算错误,附注一致性,标点格式";
    const summaryMode = json.summary === true;
    const batchResults = json.batchResults || [];
    const images = json.images || [];
    const batchIndex = json.batchIndex || 0;
    const totalBatches = json.totalBatches || 1;
    const summaryGroup = json.summaryGroup || 0;
    const totalSummaryGroups = json.totalSummaryGroups || 1;
    const isFinalMerge = json.isFinalMerge === true;

    if (!apiKey) { sendJSON(res, 400, { error: "缺少 API Key" }); return; }

    // ==================== 汇总模式 ====================
    if (summaryMode) {
      if (!batchResults || batchResults.length === 0) { sendJSON(res, 400, { error: "缺少 batchResults" }); return; }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      try {
        let systemPrompt, userText;

        if (isFinalMerge) {
          // 最终合并
          systemPrompt = buildFinalMergePrompt();
          userText = `前半部分汇总：\n\n${batchResults[0] || ""}\n\n---\n\n后半部分汇总：\n\n${batchResults[1] || ""}`;
        } else {
          // 分组汇总
          systemPrompt = buildGroupSummaryPrompt(summaryGroup, totalSummaryGroups);
          userText = `第${summaryGroup}组审查结果如下：\n\n` + batchResults.map((r, i) => `--- 批次 ${i + 1 + (summaryGroup - 1) * batchResults.length} ---\n${r}`).join("\n\n");
        }

        sendSSE(res, "stage", { stage: "summary", message: isFinalMerge ? "正在合并最终审查报告..." : `正在生成汇总报告 (${summaryGroup}/${totalSummaryGroups})...`, summaryGroup, totalSummaryGroups, isFinalMerge });

        const stream = streamKimiChat(apiKey, "kimi-k2-turbo-preview", [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ]);

        for await (const event of stream) {
          sendSSE(res, "content", { content: event.content });
        }
        sendSSE(res, "done", { message: isFinalMerge ? "最终报告完成" : `汇总 ${summaryGroup}/${totalSummaryGroups} 完成`, summaryGroup, totalSummaryGroups, isFinalMerge });
      } catch (err) {
        console.error("汇总出错:", err);
        sendSSE(res, "error", { error: err.message || "汇总失败", summaryGroup });
      } finally {
        res.end();
      }
      return;
    }

    // ==================== 普通批次审查模式 ====================
    if (!images || images.length === 0) { sendJSON(res, 400, { error: "未收到图片" }); return; }
    let finalImages = images;
    if (finalImages.length > MAX_IMAGES_PER_BATCH) finalImages = finalImages.slice(0, MAX_IMAGES_PER_BATCH);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    try {
      sendSSE(res, "stage", { stage: "review", message: `正在审查第 ${batchIndex + 1}/${totalBatches} 批`, batchIndex, totalBatches, pageCount: finalImages.length });
      const systemPrompt = buildSystemPrompt(dimensions);
      const userContent = buildBatchUserContent(finalImages, batchIndex, totalBatches);
      const stream = streamKimiChat(apiKey, "kimi-k2.6", [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ]);
      for await (const event of stream) { sendSSE(res, "content", { content: event.content }); }
      sendSSE(res, "done", { message: `第 ${batchIndex + 1}/${totalBatches} 批完成`, batchIndex, totalBatches });
    } catch (err) {
      console.error(`批次 ${batchIndex} 出错:`, err);
      sendSSE(res, "error", { error: err.message || "批次审查失败", batchIndex });
    } finally {
      res.end();
    }
  } catch (err) {
    console.error("请求处理出错:", err);
    if (!res.headersSent) sendJSON(res, 500, { error: `服务器内部错误: ${err.message}` });
  }
};

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };