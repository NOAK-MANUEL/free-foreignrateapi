import { Request, Response } from "express";
import requestIp from "request-ip";
import geoip from "geoip-lite";
import express from "express";
import cors from "cors";
import { currencyData } from "../currencyData.js";
import { checkExchangeData, saveSingleRate } from "../actions.js";
import NodeCache from "node-cache";
import dot from "dotenv";

dot.config({ path: ".env" });

declare global {
  namespace Express {
    interface Request {
      geo?: geoip.Lookup | null;
    }
  }
}

const app = express();

app.use(
  cors({
    origin: "*",
  })
);
app.use(requestIp.mw());
app.set("trust proxy", true);

function cleanIpAddress(ip: string | null): string {
  if (!ip) return "unknown";
  let cleaned = ip;
  cleaned = cleaned.replace(/^::ffff:/, "");
  if (cleaned === "::1") {
    cleaned = "127.0.0.1";
  }
  if (cleaned.includes(":") && cleaned !== "::1") {
    const parts = cleaned.split(":");
    if (parts.length >= 4) {
      const lastPart = parts[parts.length - 1];
      if (/^\d+$/.test(lastPart)) {
        cleaned = parts.slice(0, parts.length - 1).join(":");
      }
    }
  }
  return cleaned;
}

const nodeCache = new NodeCache({ stdTTL: 60 });
app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const rawIp = requestIp.getClientIp(req);
    req.geo =
      geoip.lookup(req.query["userIp"] as string) ??
      geoip.lookup(cleanIpAddress(rawIp));

    const userCountry = geoip.lookup(cleanIpAddress(rawIp))?.country;

    if (!userCountry) {
      return res.status(401).json({
        success: false,
        message: "Couldn't detect origin",
      });
    }
    const ip = cleanIpAddress(rawIp);
    let userUsage = nodeCache.get(ip) ?? 0;
    if (Number(userUsage) >= 30) {
      return res.status(400).json({
        success: false,
        message: "Exceeded limit",
      });
    }
    nodeCache.set(ip, Number(userUsage) + 1);
    console.log({
      ip,
      userCountry,
      userUsage,
      date: new Date().toDateString(),
      time: new Date().toTimeString(),
    });

    next();
  }
);

app.use(express.json());

type ExchangeRates = {
  [currencyCode: string]: number;
};

app.get("/convert", async (req: Request, res: Response) => {
  const { from, to, amount } = req.query;
  let rate: number = 0;
  try {
    if (!from || !to || !amount) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }
    const parsed_from = String(from).toUpperCase();
    const parsed_to = String(to).toUpperCase();
    const response = await checkExchangeData(parsed_from);
    if (!response) {
      return res.status(400).json({
        success: false,
        message: "Unsupported Currency",
      });
    }
    const targetedCurrency = Object.values(currencyData).find(
      (current) => current.code === parsed_to
    );
    if (!targetedCurrency) {
      return res.status(422).json({
        success: false,
        message: "Unsupported Currency",
      });
    }
    const data = response.data as ExchangeRates;
    rate = data[parsed_to] ?? 0;

    const totalAmount = Number(rate * Number(amount ?? 0));
    const { symbol, code, currency } = targetedCurrency;

    res.status(200).json({
      success: true,
      info: {
        currencySymbol: symbol,
        priceTag: symbol + totalAmount.toFixed(2),
        amount: totalAmount,
        currencyCode: code,
        currencyName: currency,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    if (rate !== 0) {
      await saveSingleRate(from!.toString(), to!.toString(), rate);
    }
  }
});

app.get("/auto-convert", async (req: Request, res: Response) => {
  const { defaultCountry, amount, from } = req.query;

  let ip = req.geo?.country ?? defaultCountry ?? "US";
  let rate: number = 0;
  const {
    code,
    symbol,
    currency,
  }: { code: string; symbol: string; currency: string } =
    currencyData[String(ip)];
  try {
    let response = await checkExchangeData(String(from).toUpperCase() ?? "USD");

    if (!response) {
      throw new Error("Couldn't get exchange rate");
    }

    const data = response.data as ExchangeRates;
    rate = data[code] ?? 0;

    const totalAmount = Number(rate * Number(amount ?? 0));

    res.status(200).json({
      success: true,
      info: {
        currencySymbol: symbol,
        priceTag: symbol + totalAmount.toFixed(2),
        amount: totalAmount,
        currencyCode: code,
        currencyName: currency,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    if (rate !== 0) {
      saveSingleRate(from!.toString(), code, rate);
    }
  }
});

app.get("/auto-toggle", async (req: Request, res: Response) => {
  type QueryData = {
    parsed_between: string;
    parsed_from: string;
  };
  let { between, from, amount } = req.query;
  if (!between || !from || !amount) {
    return res.status(422).json({
      success: false,
      message: "No currency passed",
    });
  }
  try {
    const parsedAmount = Number(amount ?? 0);
    let { parsed_between, parsed_from }: QueryData = {
      parsed_between: String(between),
      parsed_from: String(from).toUpperCase(),
    };
    const raw = Array.isArray(JSON.parse(parsed_between))
      ? JSON.parse(parsed_between)
      : ["USD"];
    const parsedValues = raw.map((item: any) => {
      if (typeof item !== "string") {
        throw new Error("between must only contain strings");
      }
      return item.toUpperCase();
    });
    const ip = req.geo?.country ?? "US";
    let { code, symbol, currency } = currencyData[ip];
    if (!parsedValues.includes(code)) {
      code = parsedValues[Math.floor(Math.random() * parsedValues.length)];
      for (const currency of Object.values(currencyData)) {
        if (currency.code === code) {
          symbol = currency.symbol;
        }
      }
    }

    const response = await checkExchangeData(parsed_from);
    if (!response) {
      throw new Error("Couldn't get exchange rate");
    }
    const data = response.data as ExchangeRates;
    const rate = data[code] ?? 0;

    const totalAmount = Number(rate * parsedAmount);
    res.status(200).json({
      success: true,
      info: {
        currencySymbol: symbol,
        priceTag: symbol + totalAmount.toFixed(2),
        amount: totalAmount,
        currencyCode: code,
        currencyName: currency,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/rate", async (req: Request, res: Response) => {
  type QueryData = {
    from: string;
    to: string;
  };
  let { to, from } = req.query as QueryData;
  let rate: number = 0;
  if (!from || !to) {
    return res.status(422).json({
      success: false,
      message: "No currency passed",
    });
  }
  try {
    let targetedCurrency = Object.values(currencyData).find(
      (target) => target.code === to
    );

    if (!targetedCurrency) {
      throw new Error("Currency not found");
    }

    const response = await checkExchangeData(from);

    if (!response) {
      throw new Error("Couldn't fetch currency rate");
    }

    const data = response.data as ExchangeRates;
    rate = data[to] ?? 0;

    res.status(200).json({
      success: true,
      info: {
        from,
        to,
        rate,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    if (rate !== 0) {
      saveSingleRate(from!.toString(), to!.toString(), rate);
    }
  }
});
app.get("/latest", async (req: Request, res: Response) => {
  type QueryData = {
    base: string;
  };
  let { base } = req.query as QueryData;
  if (!base) {
    return res.status(422).json({
      success: false,
      message: "No base currency found",
    });
  }
  try {
    const response = await checkExchangeData(base);
    if (!response?.data) {
      throw new Error("Currency could not be found");
    }

    const rates = response.data as ExchangeRates;

    // const todayStart = new Date();
    // todayStart.setHours(0, 0, 0, 0);

    // const todayEnd = new Date();
    // todayEnd.setHours(23, 59, 59, 999);

    // const baseExist = await prisma.historyData.findFirst({
    //   where: {
    //     base,
    //     date: {
    //       gte: todayStart,
    //       lte: todayEnd,
    //     },
    //   },
    // });

    // if (!baseExist) {
    //   await prisma.historyData.create({ data: { base, rate: rates } });
    // }

    res.status(200).json({
      success: true,
      base,
      rates,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
app.get("/currencies", async (req: Request, res: Response) => {
  try {
    res.status(200).json({
      success: true,
      currencies: currencyData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
app.get("/status", (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Foreign Rate API is working normally",
  });
});

app.use((req: Request, res: Response) => {
  res.status(404).send("Path not found");
});

// app.listen(8000, () => {
//   console.log("hello");
// });

export default app;
