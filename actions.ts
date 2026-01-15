import NodeCache from "node-cache";
import prisma from "./prisma";
// import { Resend } from "resend";

type CurrencyType = {
  nextUpdate: Date;
  data: Record<string, number>;
};
class CurrencyClass extends NodeCache {
  getData(key: string): CurrencyType | null {
    return super.get(key) as CurrencyType | null;
  }
  setData(key: string, value: CurrencyType | null): boolean {
    return super.set(key, value);
  }
}
const currencyCache = new CurrencyClass({ stdTTL: 86400 });

export async function fetchData(baseCode: string) {
  let response = await fetch(process.env.EXCHANGE_API + baseCode.toUpperCase());
  if (!response.ok) {
    throw new Error(await response.text());
  }

  let data: any = await response.json();

  if (data.result !== "success") {
    response = await fetch(process.env.EXCHANGE_API2 + baseCode.toUpperCase());
    data = await response.json();

    if (data.result !== "success") {
      throw new Error("Failed to fetch exchange data");
    }
  }

  return {
    data: data.rates ?? data.conversion_rates,
    nextUpdate: new Date(data.time_next_update_utc),
  };
}

export async function checkExchangeData(from: string) {
  let exchangeData = currencyCache.getData(from);
  if (!exchangeData) {
    const { nextUpdate, data } = await fetchData(from);
    currencyCache.setData(from, { nextUpdate, data });
    exchangeData = currencyCache.getData(from);
  }
  if (new Date(exchangeData?.nextUpdate!).getTime() - Date.now() <= 100) {
    const { nextUpdate, data } = await fetchData(from);
    currencyCache.setData(from, { nextUpdate, data });
    exchangeData = currencyCache.getData(from);
  }
  return exchangeData;
}

export async function saveSingleRate(from: string, to: string, rate: number) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const dataExist = await prisma.singleRate.findFirst({
      where: { date: { gte: todayStart, lte: todayEnd }, from: from, to: to },
    });

    if (!dataExist) {
      await prisma.singleRate.create({ data: { from, to, amountTo: rate } });
    }
  } catch (error) {}
}

// export const sendEmail = async (data: string) => {
//   const resend = new Resend(process.env.MAIL_KEY);
//   await resend.emails.send({
//     from: "Foreign Rate API Update <noreply@foreignrateapi.com>",
//     to: "info.foreignrateapi.com",
//     subject: "Update",
//     html: `
//     <div style="font-family: Arial, sans-serif; background-color: #f4f7f9; padding: 10px;">
//       <div style="max-width: 600px; margin: auto; background-color: #ffffff; border: 1px solid #dddddd; border-radius: 8px; padding: 30px;">

//        ${data}

//       </div>
//     </div>
//   `,
//   });
// };
