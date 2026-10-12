// Vercel Serverless Function: POST /api/search
// Configure GEMINI_API_KEY in the Vercel project environment. Never expose it to the browser.
const MODEL = "gemini-2.5-flash";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CHAT_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 3000;

function respond(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(payload);
}

async function callGemini({ apiKey, contents, systemInstruction, generationConfig }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      contents,
      generationConfig
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || "Gemini API request failed.");
    err.upstreamStatus = response.status;
    throw err;
  }
  const output = (data?.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("").trim();
  if (!output) throw new Error("Gemini returned an empty response.");
  return output;
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch {
    // Keep a narrow fallback for providers that wrap otherwise valid JSON in fences.
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(stripped);
  }
}

async function searchProducts(apiKey, query) {
  const output = await callGemini({
    apiKey,
    contents: [{ role: "user", parts: [{ text:
      `Find 2 or 3 specific household appliance product models matching this request: ${JSON.stringify(query)}. ` +
      "Give realistic typical running power in watts and typical daily hours of use. " +
      "Return only a JSON array of objects with exactly these keys: name (string), watt (number), hours (number), compressor (boolean). " +
      "Use distinct plausible product models, no Markdown or prose. Set compressor true only for devices with a compressor such as air conditioners, refrigerators, or dehumidifiers."
    }] }],
    generationConfig: {
      temperature: 0.25,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" }, watt: { type: "NUMBER" },
            hours: { type: "NUMBER" }, compressor: { type: "BOOLEAN" }
          },
          required: ["name", "watt", "hours", "compressor"],
          propertyOrdering: ["name", "watt", "hours", "compressor"]
        }
      }
    }
  });

  const parsed = parseJson(output);
  if (!Array.isArray(parsed)) throw new Error("Gemini returned invalid model data.");
  const models = parsed.slice(0, 3).map(item => ({
    name: typeof item?.name === "string" ? item.name.trim().slice(0, 100) : "",
    watt: Number(item?.watt),
    hours: Number(item?.hours),
    compressor: item?.compressor === true
  })).filter(item => item.name && Number.isFinite(item.watt) && item.watt >= 1 && item.watt <= 100000 &&
    Number.isFinite(item.hours) && item.hours >= 0.1 && item.hours <= 24);
  if (models.length < 2) throw new Error("Gemini returned too few valid appliance models.");
  return models;
}

async function temperatureImpact(apiKey, applianceName, temperature, watts) {
  const output = await callGemini({
    apiKey,
    contents: [{ role: "user", parts: [{ text:
      `Estimate how an outside temperature of ${temperature} °C affects the power draw of a household ${JSON.stringify(applianceName)}. ` +
      `Its typical rated/observed draw is ${watts} W. Return one JSON object only: {"multiplier": number, "reason": string}. ` +
      "The multiplier must represent the power draw relative to a typical mild-ambient baseline, usually close to 1.0, and stay between 0.5 and 2.0. " +
      "Use a cautious estimate and one short reason sentence. Avoid implying exact measurement; mention if the effect is uncertain."
    }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { multiplier: { type: "NUMBER" }, reason: { type: "STRING" } },
        required: ["multiplier", "reason"],
        propertyOrdering: ["multiplier", "reason"]
      }
    }
  });
  const parsed = parseJson(output);
  const multiplier = Number(parsed?.multiplier);
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 240) : "";
  if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 2 || !reason) {
    throw new Error("Gemini returned invalid temperature impact data.");
  }
  return { multiplier, reason };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, { error: "Method not allowed." });
  }
  const length = Number(req.headers["content-length"] || 0);
  if (length > MAX_BODY_BYTES) return respond(res, 413, { error: "Request body is too large." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return respond(res, 500, { error: "AI service is not configured." });
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    if (body.type === "search") {
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 250) : "";
      if (!query) return respond(res, 400, { error: "A product query is required." });
      const models = await searchProducts(apiKey, query);
      return respond(res, 200, { models });
    }

    if (body.type === "temperature") {
      const applianceName = typeof body.applianceName === "string" ? body.applianceName.trim().slice(0, 100) : "";
      const temperature = Number(body.temperature);
      const watts = Number(body.watts);
      if (!applianceName) return respond(res, 400, { error: "An appliance name is required." });
      if (!Number.isFinite(temperature) || temperature < -40 || temperature > 60) {
        return respond(res, 400, { error: "Temperature must be between -40 and 60 °C." });
      }
      if (!Number.isFinite(watts) || watts < 1 || watts > 100000) {
        return respond(res, 400, { error: "Appliance watts are invalid." });
      }
      const impact = await temperatureImpact(apiKey, applianceName, temperature, watts);
      return respond(res, 200, impact);
    }

    return respond(res, 400, { error: "type must be 'search' or 'temperature'." });
  } catch (error) {
    // Keep provider details in server logs only; never leak the API key or raw upstream body.
    console.error("Power Profiles AI error:", error.message);
    const status = error.upstreamStatus === 429 ? 503 : 502;
    return respond(res, status, { error: "The AI service could not complete the request." });
  }
};
