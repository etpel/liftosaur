/* eslint-disable @typescript-eslint/ban-types */
import "source-map-support/register";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Endpoint, Method, Router, RouteHandler } from "yatro";
import { GoogleAuthTokenDao } from "./dao/googleAuthTokenDao";
import { UserDao, ILimitedUserDao } from "./dao/userDao";
import * as Cookie from "cookie";
import JWT from "jsonwebtoken";
import { UidFactory } from "./utils/generator";
import { Utils } from "./utils";
import rsaPemFromModExp from "rsa-pem-from-mod-exp";
import { IPartialStorage, IStorage } from "../src/types";
import { ProgramDao } from "./dao/programDao";
import { renderRecordHtml, recordImage } from "./record";
import { LogDao } from "./dao/logDao";
import { renderUserHtml, userImage } from "./user";
import { renderProgramDetailsHtml } from "./programDetails";
import { renderUsersHtml } from "../src/components/admin/usersHtml";
import { CollectionUtils } from "../src/utils/collection";
import { renderLogsHtml, ILogPayloads } from "../src/components/admin/logsHtml";
import Rollbar from "rollbar";
import { IDI } from "./utils/di";
import { runMigrations } from "../src/migrations/runner";
import { FriendDao } from "./dao/friendDao";
import { IEither } from "../src/utils/types";
import { CommentsDao } from "./dao/commentsDao";
import { LikesDao } from "./dao/likesDao";
import { ResponseUtils } from "./utils/response";
import { ImageCacher } from "./utils/imageCacher";
import { ProgramImageGenerator } from "./utils/programImageGenerator";
import { AppleAuthTokenDao } from "./dao/appleAuthTokenDao";
import { Subscriptions } from "./utils/subscriptions";
import { NodeEncoder } from "./utils/nodeEncoder";
import { renderProgramHtml } from "./program";
import { IExportedProgram, Program } from "../src/models/program";
import { Storage } from "../src/models/storage";
import { ImportExporter } from "../src/lib/importexporter";
import { UrlDao } from "./dao/urlDao";
import { AffiliateDao } from "./dao/affiliateDao";
import { renderAffiliateDashboardHtml } from "./affiliateDashboard";
import type { IAffiliateData } from "../src/pages/affiliateDashboard/affiliateDashboardContent";
import { renderUsersDashboardHtml } from "./usersDashboard";
import { DateUtils } from "../src/utils/date";
import { IUserDashboardData } from "../src/pages/usersDashboard/usersDashboardContent";
import { Mobile } from "./utils/mobile";
import { renderAffiliatesHtml } from "./affiliates";
import { FreeUserDao } from "./dao/freeUserDao";
import { renderFreeformHtml } from "./freeform";
import { LogFreeformDao } from "./dao/logFreeformDao";
import { FreeformGenerator } from "./utils/freeformGenerator";
import { SubscriptionDetailsDao } from "./dao/subscriptionDetailsDao";
import { CouponDao } from "./dao/couponDao";
import { DebugDao } from "./dao/debugDao";
import { renderPlannerHtml } from "./planner";
import { IExportedPlannerProgram } from "../src/pages/planner/models/types";
import { PlannerReformatter } from "./utils/plannerReformatter";
import { ExceptionDao } from "./dao/exceptionDao";
import { UrlUtils } from "../src/utils/url";
import { RollbarUtils } from "../src/utils/rollbar";
import { Account, IAccount } from "../src/models/account";
import { renderProgramsListHtml } from "./programsList";
import { PlannerToProgram } from "../src/models/plannerToProgram";
import { getLatestMigrationVersion } from "../src/migrations/migrations";
import { renderMainHtml } from "./main";
import { LftS3Buckets } from "./dao/buckets";

interface IOpenIdResponseSuccess {
  sub: string;
  email: string;
}

interface IOpenIdResponseError {
  error: string;
  error_description: string;
}

interface IPayload {
  event: APIGatewayProxyEvent;
  di: IDI;
}

export interface IStatsUserData {
  userId: string;
  email?: string;
  userTs?: number;
  firstAction: { ts: number; name: string };
  lastAction: { ts: number; name: string };
}

export type IEnv = "dev" | "prod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getBodyJson(event: APIGatewayProxyEvent): any {
  try {
    return JSON.parse(Buffer.from(event.body || "e30=", "base64").toString("utf8"));
  } catch (e) {
    return JSON.parse(event.body || "{}");
  }
}

async function getCurrentUserId(event: APIGatewayProxyEvent, di: IDI): Promise<string | undefined> {
  const cookies = Cookie.parse(event.headers.Cookie || event.headers.cookie || "");
  const cookieSecret = await di.secrets.getCookieSecret();
  if (cookies.session) {
    let isValid = false;
    try {
      isValid = !!JWT.verify(cookies.session, cookieSecret);
    } catch (e:any) {
      if (e.constructor.name !== "JsonWebTokenError") {
        throw e;
      }
    }
    if (isValid) {
      const session = JWT.decode(cookies.session) as Record<string, string>;
      return session.userId;
    }
  }
  return undefined;
}

async function getCurrentLimitedUser(event: APIGatewayProxyEvent, di: IDI): Promise<ILimitedUserDao | undefined> {
  const userId = await getCurrentUserId(event, di);
  if (userId != null) {
    return new UserDao(di).getLimitedById(userId);
  } else {
    return undefined;
  }
}

const postVerifyAppleReceiptEndpoint = Endpoint.build("/api/verifyapplereceipt");
const postVerifyAppleReceiptHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postVerifyAppleReceiptEndpoint
> = async ({ payload, match: { params } }) => {
  const { event, di } = payload;
  const bodyJson = getBodyJson(event);
  const { appleReceipt, userId } = bodyJson;
  if (appleReceipt == null) {
    return ResponseUtils.json(200, event, { result: false });
  }
  const subscriptions = new Subscriptions(di.log, di.secrets);
  const appleJson = await subscriptions.getAppleVerificationJson(appleReceipt);
  let verifiedAppleReceipt = undefined;
  if (appleJson) {
    verifiedAppleReceipt = await subscriptions.verifyAppleReceiptJson(appleReceipt, appleJson);
    if (verifiedAppleReceipt && userId) {
      const subscriptionDetails = await subscriptions.getAppleVerificationInfo(userId, appleJson);
      if (subscriptionDetails) {
        await new SubscriptionDetailsDao(di).add(subscriptionDetails);
      }
    }
    return ResponseUtils.json(200, event, { result: !!verifiedAppleReceipt });
  } else {
    return ResponseUtils.json(200, event, { result: true });
  }
};

const postVerifyGooglePurchaseTokenEndpoint = Endpoint.build("/api/verifygooglepurchasetoken");
const postVerifyGooglePurchaseTokenHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postVerifyGooglePurchaseTokenEndpoint
> = async ({ payload }) => {
  const { event, di } = payload;
  const bodyJson = getBodyJson(event);
  const { googlePurchaseToken, userId } = bodyJson;
  if (googlePurchaseToken == null) {
    return ResponseUtils.json(200, event, { result: false });
  }
  const subscriptions = new Subscriptions(di.log, di.secrets);
  const googleJson = await subscriptions.getGooglePurchaseTokenJson(googlePurchaseToken);
  let verifiedGooglePurchaseToken = undefined;
  if (googleJson) {
    verifiedGooglePurchaseToken = await subscriptions.verifyGooglePurchaseTokenJson(googlePurchaseToken, googleJson);
    if (verifiedGooglePurchaseToken && userId && !("error" in googleJson)) {
      const subscriptionDetails = await subscriptions.getGoogleVerificationInfo(userId, googleJson);
      if (subscriptionDetails) {
        await new SubscriptionDetailsDao(di).add(subscriptionDetails);
      }
    }
  }
  return ResponseUtils.json(200, event, { result: !!verifiedGooglePurchaseToken });
};

const getStorageEndpoint = Endpoint.build("/api/storage", { tempuserid: "string?", key: "string?", userid: "string?" });
const getStorageHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getStorageEndpoint> = async ({
  payload,
  match,
}) => {
  const { event, di } = payload;
  const querystringParams = event.queryStringParameters || {};
  let userId;
  let setCookie: string | undefined = undefined;
  if (match.params.key != null && match.params.userid != null && match.params.key === (await di.secrets.getApiKey())) {
    userId = querystringParams.userid;
    const cookieSecret = await di.secrets.getCookieSecret();
    const session = JWT.sign({ userId: userId }, cookieSecret);
    setCookie = Cookie.serialize("session", session, {
      httpOnly: true,
      domain: ".liftosaur.com",
      path: "/",
      expires: new Date(new Date().getFullYear() + 10, 0, 1),
    });
  } else {
    userId = await getCurrentUserId(event, di);
  }
  let keyResult: { key: string; isClaimed: boolean } | undefined;
  if (match.params.tempuserid) {
    keyResult = await new FreeUserDao(di).getKey(match.params.tempuserid);
  }
  const key = keyResult ? (keyResult.isClaimed ? keyResult.key : "unclaimed") : undefined;
  if (userId != null) {
    const userDao = new UserDao(di);
    const user = await userDao.getById(userId);
    if (user != null) {
      di.log.log(`Responding user data, id: ${user.storage.id}, original id: ${user.storage.originalId}`);
      user.storage.originalId = user.storage.originalId || Date.now();
      return ResponseUtils.json(
        200,
        event,
        {
          storage: user.storage,
          email: user.email,
          user_id: user.id,
          key,
        },
        setCookie ? { "set-cookie": setCookie } : undefined
      );
    }
  }
  return ResponseUtils.json(200, event, { key });
};

const saveDebugStorageEndpoint = Endpoint.build("/api/debugstorage");
const saveDebugStorageHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof saveDebugStorageEndpoint> = async ({
  payload,
}) => {
  const { event, di } = payload;
  const userid = await getCurrentUserId(event, di);
  if (userid != null) {
    const bodyJson = getBodyJson(event);
    const { oldStorage, newStorage, mergedStorage, prefix } = bodyJson;
    const exceptionDao = new ExceptionDao(di);
    await exceptionDao.storeStorages(prefix, userid, oldStorage, newStorage, mergedStorage);
  }
  return ResponseUtils.json(200, event, {});
};

const pingEndpoint = Endpoint.build("/api/ping/:originalid");
const pingHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof pingEndpoint> = async ({ payload, match }) => {
  const { event, di } = payload;
  const user = await getCurrentLimitedUser(event, di);
  const originalid = parseInt(match.params.originalid, 10);
  if (user?.storage.originalId != null && user.storage.id !== originalid) {
    return ResponseUtils.json(200, event, { status: "stale" });
  }
  return ResponseUtils.json(200, event, { status: "ok" });
};

const saveStorageEndpoint = Endpoint.build("/api/storage");
const saveStorageHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof saveStorageEndpoint> = async ({
  payload,
}) => {
  const { event, di } = payload;
  const user = await getCurrentLimitedUser(event, di);
  if (user != null) {
    const bodyJson = getBodyJson(event);
    const fields: string[] | undefined = bodyJson.fields;
    const storage: IPartialStorage | IStorage = bodyJson.storage;
    const userDao = new UserDao(di);
    di.log.log(
      `IDS: storage.id: ${storage.id}, storage.originalId: ${storage.originalId}, user.storage.id: ${user.storage.id}, user.storage.originalId: ${user.storage.originalId}`
    );

    if (storage.originalId == null || user.storage.originalId == null || user.storage.id === storage.originalId) {
      di.log.log("Appendable safe update");
      Storage.updateIds(storage);
      await userDao.saveStorage(user, storage);
      return ResponseUtils.json(200, event, { status: "success", newOriginalId: storage.originalId });
    } else {
      di.log.log("Dangerous update, merging");
      if (storage.programs == null || storage.history == null || storage.stats == null) {
        di.log.log("Requesting full storage");
        return ResponseUtils.json(200, event, { status: "request", data: ["programs", "stats", "history"] });
      } else if (Storage.isFullStorage(storage)) {
        di.log.log("Merging the storages");
        const fullUser = await userDao.getById(user.id);
        if (fullUser != null) {
          const aStorage = await runMigrations(di.fetch, fullUser.storage);
          const bStorage = await runMigrations(di.fetch, storage);
          const oldStorage = aStorage.id < bStorage.id ? aStorage : bStorage;
          const newStorage = aStorage.id < bStorage.id ? bStorage : aStorage;
          const mergedStorage = Storage.mergeStorage(oldStorage, newStorage, false, fields);

          const exceptionDao = new ExceptionDao(di);
          await exceptionDao.storeStorages("Merge on lambda", user.id, oldStorage, newStorage, mergedStorage);

          Storage.updateIds(mergedStorage);
          await userDao.saveStorage(fullUser, mergedStorage);
          return ResponseUtils.json(200, event, { status: "merged", storage: mergedStorage });
        } else {
          throw new Error(`Can't find user ${user.id}`);
        }
      } else {
        throw new Error(`Accepted storage wasn't a full storage for user ${user.id}`);
      }
    }
  }
  return ResponseUtils.json(200, event, {});
};

// function printHistoryRecord(historyRecord: IHistoryRecord): string {
//   return (
//     historyRecord.entries
//       .map((entry) => {
//         return `${entry.exercise.id} - ${entry.sets.map((s) => s.completedReps).join("/")}`;
//       })
//       .join("\n") + "\n"
//   );
// }

const saveDebugEndpoint = Endpoint.build("/api/debug");
const saveDebugHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof saveDebugEndpoint> = async ({
  payload,
}) => {
  const { event, di } = payload;
  const { id, data } = getBodyJson(event);
  const debugDao = new DebugDao(di);
  await debugDao.store(id, JSON.stringify(data));
  return ResponseUtils.json(200, event, { data: "ok" });
};

interface IAppleKeysResponse {
  keys: Array<{
    kty: string;
    kid: string;
    use: string;
    alg: string;
    n: string;
    e: string;
  }>;
}

const appleLoginEndpoint = Endpoint.build("/api/signin/apple");
const appleLoginHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof appleLoginEndpoint> = async ({
  payload,
}) => {
  const { event, di } = payload;
  const env = Utils.getEnv();
  const bodyJson = getBodyJson(event);
  const { idToken, id } = bodyJson;
  const keysResponse = await di.fetch("https://appleid.apple.com/auth/keys");
  const keysJson = (await keysResponse.json()) as IAppleKeysResponse;
  const decodedToken = JWT.decode(idToken!, { complete: true });
  if (decodedToken) {
    const header = (decodedToken as Record<string, Record<string, string>>).header;
    const content = (decodedToken as Record<string, Record<string, string>>).payload;
    const kid = header.kid;
    const key = keysJson.keys.find((k) => k.kid === kid);
    if (key != null) {
      const pem = rsaPemFromModExp(key.n, key.e);
      const result = JWT.verify(idToken, pem, {
        issuer: "https://appleid.apple.com",
        audience: content.aud,
      }) as { sub?: string; email?: string } | undefined;
      if (result?.sub) {
        const email = result.email || "noemail@example.com";
        const cookieSecret = await di.secrets.getCookieSecret();

        await new AppleAuthTokenDao(di).store(env, idToken, result.sub);
        const userDao = new UserDao(di);
        let user = await userDao.getByAppleId(result.sub);
        let userId = user?.id;
        const initialUserId = userId;

        if (userId == null) {
          userId = (id as string) || UidFactory.generateUid(12);
          user = UserDao.build(userId, email, { appleId: result.sub });
          await userDao.store(user);
        }

        const session = JWT.sign({ userId: userId }, cookieSecret);
        const resp = {
          email: email,
          user_id: userId,
          storage: initialUserId == null ? undefined : user!.storage,
        };

        return {
          statusCode: 200,
          body: JSON.stringify(resp),
          headers: {
            ...ResponseUtils.getHeaders(event),
            "set-cookie": Cookie.serialize("session", session, {
              httpOnly: true,
              domain: ".liftosaur.com",
              path: "/",
              expires: new Date(new Date().getFullYear() + 10, 0, 1),
            }),
          },
        };
      }
    }
  }

  return ResponseUtils.json(403, event, { error: "invalid_token" });
};

const googleLoginEndpoint = Endpoint.build("/api/signin/google");
const googleLoginHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof googleLoginEndpoint> = async ({
  payload,
}) => {
  const { event, di } = payload;
  const env = Utils.getEnv();
  const bodyJson = getBodyJson(event);
  const { token, id, forceuseremail } = bodyJson;
  let openIdJson: IOpenIdResponseSuccess | IOpenIdResponseError;
  if (env === "dev" && forceuseremail != null) {
    openIdJson = {
      email: forceuseremail,
      sub: `${forceuseremail}googleId`,
    };
  } else {
    const url = `https://openidconnect.googleapis.com/v1/userinfo?access_token=${token}`;
    const googleApiResponse = await di.fetch(url);
    openIdJson = await googleApiResponse.json();
  }
  const cookieSecret = await di.secrets.getCookieSecret();

  if ("error" in openIdJson) {
    const url = `https://www.googleapis.com/oauth2/v1/tokeninfo?id_token=${token}`;
    const googleApiResponse = await di.fetch(url);
    const response = await googleApiResponse.json();
    if ("error" in response) {
      return ResponseUtils.json(403, event, openIdJson);
    } else {
      openIdJson = {
        sub: response.user_id,
        email: response.email,
      };
    }
  }

  await new GoogleAuthTokenDao(di).store(env, token, openIdJson.sub);
  const userDao = new UserDao(di);
  let user = await userDao.getByGoogleId(openIdJson.sub);
  let userId = user?.id;
  const initialUserId = userId;

  if (userId == null) {
    userId = (id as string) || UidFactory.generateUid(12);
    user = UserDao.build(userId, openIdJson.email, { googleId: openIdJson.sub });
    await userDao.store(user);
  }

  const session = JWT.sign({ userId: userId }, cookieSecret);
  const resp = {
    email: openIdJson.email,
    user_id: userId,
    storage: initialUserId == null ? undefined : user!.storage,
  };

  return {
    statusCode: 200,
    body: JSON.stringify(resp),
    headers: {
      ...ResponseUtils.getHeaders(event),
      "set-cookie": Cookie.serialize("session", session, {
        httpOnly: true,
        domain: ".liftosaur.com",
        path: "/",
        expires: new Date(new Date().getFullYear() + 10, 0, 1),
      }),
    },
  };
};

const signoutEndpoint = Endpoint.build("/api/signout");
const signoutHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof signoutEndpoint> = async ({ payload }) => {
  const { event } = payload;
  return {
    statusCode: 200,
    headers: {
      ...ResponseUtils.getHeaders(event),
      "set-cookie": Cookie.serialize("session", "", {
        httpOnly: true,
        domain: ".liftosaur.com",
        path: "/",
        expires: new Date(1970, 0, 1),
      }),
    },
    body: "{}",
  };
};

const getProgramsEndpoint = Endpoint.build("/api/programs");
const getProgramsHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getProgramsEndpoint> = async ({
  payload,
}) => {
  const { event, di } = payload;
  const programs = await new ProgramDao(di).getAll();
  return ResponseUtils.json(200, event, { programs });
};

const getHistoryRecordEndpoint = Endpoint.build("/api/record", { user: "string?", id: "number?" });
const getHistoryRecordHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getHistoryRecordEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  const error: { message?: string } = {};
  if (params.user != null && params.id != null && !isNaN(params.id)) {
    const result = await new UserDao(di).getById(params.user);
    if (result != null) {
      const storage: IStorage = result.storage;
      const history = storage.history;
      const historyRecord = history.find((hi) => hi.id === params.id);
      if (historyRecord != null) {
        return {
          statusCode: 200,
          body: renderRecordHtml(
            di.fetch,
            { history, record: historyRecord, settings: storage.settings },
            params.user,
            params.id
          ),
          headers: { "content-type": "text/html" },
        };
      } else {
        error.message = "Can't find history record";
      }
    } else {
      error.message = "Can't find user";
    }
  } else {
    error.message = "Missing required params - 'user' or 'id'";
  }
  return ResponseUtils.json(400, event, { error });
};

const getHistoryRecordImageEndpoint = Endpoint.build("/api/recordimage", {
  user: "string",
  id: "number",
});
const getHistoryRecordImageHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getHistoryRecordImageEndpoint
> = async ({ payload, match: { params } }) => {
  const { event, di } = payload;
  return ImageCacher.cache(di, event, `historyrecordimage${event.path}-${params.user}-${params.id}.png`, async () => {
    const result = await new UserDao(di).getById(params.user);
    if (result != null) {
      const imageResult = await recordImage(result.storage, params.id);
      if (imageResult.success) {
        return { success: true, data: imageResult.data };
      } else {
        return { success: false, error: imageResult.error };
      }
    } else {
      return { success: false, error: "Can't find user" };
    }
  });
};

const getProgramImageEndpoint = Endpoint.build("/api/programimage/:id");
const getProgramImageHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getProgramImageEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  return ImageCacher.cache(di, event, `programimage${event.path}-${params.id}.png`, async () => {
    const program = await new ProgramDao(di).get(params.id);
    if (program != null) {
      const imageResult = await new ProgramImageGenerator().generate({ program: program.program });
      if (imageResult.success) {
        return { success: true, data: imageResult.data };
      } else {
        return { success: false, error: imageResult.error };
      }
    } else {
      return { success: false, error: "Can't find program" };
    }
  });
};

const publishProgramEndpoint = Endpoint.build("/api/publishprogram", { key: "string" });
const publishProgramHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof publishProgramEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  if (params.key === (await di.secrets.getApiKey())) {
    const program = getBodyJson(event).program;
    if (program != null) {
      await new ProgramDao(di).save(program);
      return ResponseUtils.json(200, event, { data: "ok" });
    } else {
      return ResponseUtils.json(400, event, { error: "missing program in payload" });
    }
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

const postAddFreeUserEndpoint = Endpoint.build("/api/addfreeuser/:id", { key: "string" });
const postAddFreeUserHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof postAddFreeUserEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  if (params.key === (await di.secrets.getApiKey())) {
    await new FreeUserDao(di).create(params.id, Date.now() + 1000 * 60 * 60 * 24 * 365, false);
    return ResponseUtils.json(200, event, { data: "ok" });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

const postCreateCouponEndpoint = Endpoint.build("/api/coupon/:ttl", { key: "string", info: "string?" });
const postCreateCouponHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof postCreateCouponEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  const ttlMs = parseInt(params.ttl, 10);
  if (!isNaN(ttlMs) && params.key === (await di.secrets.getApiKey())) {
    const coupon = await new CouponDao(di).create(ttlMs, params.info);
    return ResponseUtils.json(200, event, { data: coupon });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

const postClaimCouponEndpoint = Endpoint.build("/api/coupon/claim/:code");
const postClaimCouponHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof postClaimCouponEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  const couponDao = new CouponDao(di);
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId == null) {
    return ResponseUtils.json(401, event, { error: "not_authorized" });
  }

  const coupon = await couponDao.get(params.code);
  if (!coupon) {
    return ResponseUtils.json(404, event, { error: "coupon_not_found" });
  }

  if (coupon.isClaimed) {
    return ResponseUtils.json(400, event, { error: "coupon_already_claimed" });
  }

  await couponDao.claim(coupon);
  const freeuser = await new FreeUserDao(di).create(currentUserId, Date.now() + coupon.ttlMs, true, coupon.code);
  return ResponseUtils.json(200, event, { data: { key: freeuser.key, expires: freeuser.expires } });
};

const logEndpoint = Endpoint.build("/api/log");
const logHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof logEndpoint> = async ({ payload }) => {
  const { event, di } = payload;
  const env = Utils.getEnv();
  const { user, action, affiliates, platform, subscriptions, key, enforce, referrer } = getBodyJson(event);
  let data: { result: "ok" | "error"; clear?: boolean };
  if (user && action) {
    let clear: boolean | undefined;
    if (key != null && (env === "prod" || enforce)) {
      const fetchedKey = await new FreeUserDao(di).verifyKey(user);
      if (fetchedKey !== key) {
        clear = true;
      }
    }
    await new LogDao(di).increment(user, action, platform, subscriptions, affiliates, referrer);
    data = { result: "ok", clear };
  } else {
    data = { result: "error" };
  }
  return ResponseUtils.json(200, event, { data });
};

const getProfileEndpoint = Endpoint.build("/profile", { user: "string" });
const getProfileHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getProfileEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  const error: { message?: string } = {};
  const result = await new UserDao(di).getById(params.user);
  if (result != null) {
    const storage = result.storage;
    if (storage.settings.isPublicProfile) {
      return {
        statusCode: 200,
        body: renderUserHtml(di.fetch, storage, params.user),
        headers: { "content-type": "text/html" },
      };
    } else {
      error.message = "The user's profile is not public";
    }
  } else {
    error.message = "Can't find user";
  }
  return ResponseUtils.json(400, event, { error });
};

const getProfileImageEndpoint = Endpoint.build("/profileimage", { user: "string" });
const getProfileImageHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getProfileImageEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  return ImageCacher.cache(di, event, `profileimage${event.path}-${params.user}.png`, async () => {
    const result = await new UserDao(di).getById(params.user);
    if (result != null) {
      if (result?.storage?.settings?.isPublicProfile) {
        const imageResult = await userImage(result.storage);
        return { success: true, data: imageResult };
      } else {
        return { success: false, error: "The user's profile is not public" };
      }
    } else {
      return { success: false, error: "Can't find user" };
    }
  });
};

const getAdminUsersEndpoint = Endpoint.build("/admin/users", { key: "string" });
const getAdminUsersHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getAdminUsersEndpoint> = async ({
  payload,
  match,
}) => {
  const { event, di } = payload;
  if (match.params.key === (await di.secrets.getApiKey())) {
    const users = await new UserDao(di).getAll();
    const processedUsers = await Promise.all(
      users.map(async (u) => {
        const storage = await runMigrations(di.fetch, u.storage);

        return {
          id: u.id,
          email: u.email,
          history: storage.history.slice(0, 4),
          totalHistory: storage.history.length,
          programs: storage.programs.map((p) => p.name),
          settings: storage.settings,
          timestamp: u.createdAt,
        };
      })
    );
    processedUsers.sort((a, b) => {
      const h1 = a.history[0];
      const h2 = b.history[0];
      return (h2 == null ? 0 : Date.parse(h2.date)) - (h1 == null ? 0 : Date.parse(h1.date));
    });
    return {
      statusCode: 200,
      body: renderUsersHtml({ users: processedUsers, apiKey: match.params.key }),
      headers: { "content-type": "text/html" },
    };
  } else {
    return ResponseUtils.json(401, event, { data: "Unauthorized" });
  }
};

const getDashboardsUsersEndpoint = Endpoint.build("/dashboards/users", { key: "string" });
const getDashboardsUsersHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getDashboardsUsersEndpoint
> = async ({ payload, match }) => {
  const { event, di } = payload;
  const apiKey = await di.secrets.getApiKey();
  if (match.params.key === apiKey) {
    const lastThreeMonths = [
      DateUtils.yearAndMonth(Date.now()),
      DateUtils.yearAndMonth(Date.now() - 1000 * 60 * 60 * 24 * 30),
      DateUtils.yearAndMonth(Date.now() - 1000 * 60 * 60 * 24 * 60),
    ];
    const last3MonthslogRecords = (
      await Promise.all([
        await new LogDao(di).getAllForYearAndMonth(lastThreeMonths[0][0], lastThreeMonths[0][1]),
        // await new LogDao(di).getAllForYearAndMonth(lastThreeMonths[1][0], lastThreeMonths[1][1]),
        // await new LogDao(di).getAllForYearAndMonth(lastThreeMonths[2][0], lastThreeMonths[2][1]),
      ])
    ).flat();
    const userIds = Array.from(
      new Set(last3MonthslogRecords.filter((r) => r.action === "ls-finish-workout").map((r) => r.userId))
    );
    const [users, userPrograms, unsortedLogRecords, freeUsers, subscriptionDetailsDaos] = await Promise.all([
      new UserDao(di).getLimitedByIds(userIds),
      new UserDao(di).getProgramsByUserIds(userIds),
      new LogDao(di).getForUsers(userIds),
      new FreeUserDao(di).getAll(userIds),
      new SubscriptionDetailsDao(di).getAll(userIds),
    ]);
    const usersById = CollectionUtils.groupByKeyUniq(users, "id");
    const userIdToProgramNames = userPrograms.reduce<Record<string, { id: string; name: string }[]>>((memo, p) => {
      memo[p.userId] = memo[p.userId] || [];
      memo[p.userId].push({ id: p.id, name: `${p.name} ${p.planner ? "🎯" : ""}` });
      return memo;
    }, {});
    const subscriptionDetailsById = CollectionUtils.groupByKeyUniq(subscriptionDetailsDaos, "userId");
    const logRecords = CollectionUtils.sortBy(unsortedLogRecords, "ts", true);
    const freeUsersById = CollectionUtils.groupByKeyUniq(freeUsers, "id");

    const logRecordsByUserId = CollectionUtils.groupByKey(logRecords, "userId");
    const data: IUserDashboardData[] = Object.keys(logRecordsByUserId).map((userId) => {
      const userLogRecords = CollectionUtils.sortBy(logRecordsByUserId[userId] || [], "ts", true);
      const programNames = CollectionUtils.sort(userIdToProgramNames[userId] || [], (a, b) => {
        const user = usersById[userId];
        return user != null ? (a.id === user.storage.currentProgramId ? -1 : 1) : -1;
      }).map((p) => p.name);
      const lastAction = userLogRecords[0];
      const firstAction = userLogRecords[userLogRecords.length - 1];
      const workoutsCount = userLogRecords.filter((r) => r.action === "ls-finish-workout")[0]?.cnt || 0;
      const referrer = usersById[userId]?.storage.referrer || userLogRecords.filter((r) => !!r.referrer)[0]?.referrer;
      const platforms = Array.from(
        userLogRecords.reduce<Set<string>>((memo, record) => {
          for (const val of record.platforms || []) {
            memo.add(`${val.name}${val.version ? ` - ${val.version}` : ""}`);
          }
          return memo;
        }, new Set())
      );
      const affiliates = Array.from(
        userLogRecords.reduce<Set<string>>((memo, record) => {
          for (const val of Object.keys(record.affiliates || {})) {
            memo.add(val);
          }
          return memo;
        }, new Set())
      );
      const subscriptions = userLogRecords.reduce<Set<"apple" | "google" | "unclaimedkey" | "key">>((memo, record) => {
        for (const val of record.subscriptions || []) {
          memo.add(val);
        }
        return memo;
      }, new Set());
      if (Object.keys(usersById[userId]?.storage.subscription.apple || {}).length > 0) {
        subscriptions.add("apple");
      }
      if (Object.keys(usersById[userId]?.storage.subscription.google || {}).length > 0) {
        subscriptions.add("google");
      }
      if (usersById[userId]?.storage.subscription.key === "unclaimed") {
        subscriptions.add("unclaimedkey");
      } else if (usersById[userId]?.storage.subscription.key) {
        subscriptions.add("key");
      }
      const signupRequests = userLogRecords.reduce<[number, number, number]>(
        (memo, r) => {
          if (r.action === "ls-signup-request-signup") {
            memo[0] += r.cnt;
          } else if (r.action === "ls-signup-request-maybe-later") {
            memo[1] += r.cnt;
          } else if (r.action === "ls-signup-request-close") {
            memo[2] += r.cnt;
          }
          return memo;
        },
        [0, 0, 0]
      );

      const subscriptionDetailsDao = subscriptionDetailsById[userId];
      let subscriptionDetails = undefined;
      if (subscriptionDetailsDao) {
        let product: "yearly" | "montly" | "lifetime";
        if (subscriptionDetailsDao.product === "com.liftosaur.subscription.ios_montly") {
          product = "montly";
        } else if (subscriptionDetailsDao.product === "com.liftosaur.subscription.ios_yearly") {
          product = "yearly";
        } else if (subscriptionDetailsDao.product === "com.liftosaur.subscription.ios_lifetime") {
          product = "lifetime";
        } else {
          product = subscriptionDetailsDao.product as "montly" | "yearly" | "lifetime";
        }
        subscriptionDetails = {
          product,
          isTrial: subscriptionDetailsDao.isTrial,
          isPromo: subscriptionDetailsDao.isPromo,
          isActive: subscriptionDetailsDao.isActive,
          expires: subscriptionDetailsDao.expires,
          promoCode: subscriptionDetailsDao.promoCode,
        };
      }

      return {
        userId,
        email: usersById[userId]?.email,
        freeUserExpires: freeUsersById[userId]?.expires,
        userTs: usersById[userId]?.createdAt,
        reviewRequests: usersById[userId]?.storage?.reviewRequests || [],
        signupRequests: signupRequests,
        firstAction: { name: firstAction.action, ts: firstAction.ts },
        lastAction: { name: lastAction.action, ts: lastAction.ts },
        workoutsCount,
        platforms,
        programNames,
        affiliates,
        subscriptions: Array.from(subscriptions),
        subscriptionDetails,
        referrer,
      };
    });

    return {
      statusCode: 200,
      body: renderUsersDashboardHtml(di.fetch, apiKey, data),
      headers: { "content-type": "text/html" },
    };
  } else {
    return ResponseUtils.json(401, event, { data: "Unauthorized" });
  }
};

const getDashboardsAffiliatesEndpoint = Endpoint.build("/dashboards/affiliates/:id", { key: "string" });
const getDashboardsAffiliatesHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getDashboardsAffiliatesEndpoint
> = async ({ payload, match }) => {
  const { event, di } = payload;
  const apiKey = await di.secrets.getApiKey();
  if (match.params.key === apiKey) {
    const affiliateDao = new AffiliateDao(di);
    const userIds = await affiliateDao.getUserIds(match.params.id);
    const logRecords = await new LogDao(di).getForUsers(userIds);

    const logs = CollectionUtils.groupByKey(logRecords, "userId");
    const unsortedAffiliateData: IAffiliateData[] = Object.keys(logs).map((userId) => {
      const userLogs = logs[userId] || [];
      const sortedUserLogs = CollectionUtils.sortBy(userLogs, "ts");
      const minTs = sortedUserLogs[0].ts;
      const maxTs = sortedUserLogs[sortedUserLogs.length - 1].ts;
      const workoutLog = userLogs.filter((log) => log.action === "ls-finish-workout")[0];
      const numberOfWorkouts = workoutLog ? workoutLog.cnt : 0;
      const lastWorkoutTs = workoutLog.ts;
      const daysOfUsing = Math.floor((maxTs - minTs) / (1000 * 60 * 60 * 24));
      const isEligible = numberOfWorkouts >= 3 && daysOfUsing >= 7;
      const isPaid = false;

      return { userId, minTs, numberOfWorkouts, lastWorkoutTs, daysOfUsing, isEligible, isPaid };
    });
    const affiliateData = CollectionUtils.sortByMultiple(unsortedAffiliateData, ["isPaid", "isEligible", "minTs"]);

    return {
      statusCode: 200,
      body: renderAffiliateDashboardHtml(di.fetch, match.params.id, affiliateData),
      headers: { "content-type": "text/html" },
    };
  } else {
    return ResponseUtils.json(401, event, { data: "Unauthorized" });
  }
};

const getAdminLogsEndpoint = Endpoint.build("/admin/logs", { key: "string" });
const getAdminLogsHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getAdminLogsEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  if (params.key === (await di.secrets.getApiKey())) {
    const userLogs = await new LogDao(di).getAllSince(Date.now() - 1000 * 60 * 60 * 24 * 30);
    const users = await new UserDao(di).getAllLimited();
    const usersByKey = CollectionUtils.groupByKey(users, "id");
    const logPayloads = userLogs.reduce<ILogPayloads>((memo, log) => {
      memo[log.userId] = memo[log.userId] || { logs: [], email: usersByKey[log.userId]?.[0].email };
      memo[log.userId]!.logs.push({
        action: log.action,
        count: log.cnt,
        timestamp: log.ts,
        affiliates: log.affiliates,
        platforms: log.platforms,
        subscriptions: log.subscriptions,
      });
      return memo;
    }, {});
    return {
      statusCode: 200,
      body: renderLogsHtml({ logs: logPayloads, apiKey: params.key }),
      headers: { "content-type": "text/html" },
    };
  } else {
    return ResponseUtils.json(401, event, { data: "Unauthorized" });
  }
};

const getFriendsEndpoint = Endpoint.build("/api/friends", { username: "string" });
const getFriendsHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getFriendsEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const friends = await new FriendDao(di).getAllByUsernameOrId(currentUserId, params.username);
    return ResponseUtils.json(200, event, { friends });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

const inviteFriendEndpoint = Endpoint.build("/api/invite/:friendId");
const inviteFriendHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof inviteFriendEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const message = getBodyJson(event).message;
  const host = ResponseUtils.getReferer(event);
  const userDao = new UserDao(payload.di);
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const [currentUser, friend] = await Promise.all([
      userDao.getLimitedById(currentUserId),
      userDao.getLimitedById(params.friendId),
    ]);
    if (currentUser != null && friend != null) {
      const friendDao = new FriendDao(payload.di);
      const result = await friendDao.invite(currentUser, friend, host, message);
      if (result.success) {
        return ResponseUtils.json(200, event, {});
      } else {
        return ResponseUtils.json(400, event, { error: result.error });
      }
    }
  }
  return ResponseUtils.json(401, event, {});
};

export const acceptFriendInvitationEndpoint = Endpoint.build("/api/acceptfriendinvitation/:friendId");
const acceptFriendInvitationHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof acceptFriendInvitationEndpoint
> = async ({ payload, match: { params } }) => {
  const { event } = payload;
  const friendDao = new FriendDao(payload.di);
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const result = await friendDao.acceptInvitation(currentUserId, params.friendId);
    if (result.success) {
      return ResponseUtils.json(200, event, {});
    } else {
      return ResponseUtils.json(400, event, { error: result.error });
    }
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const removeFriendEndpoint = Endpoint.build("/api/removefriend/:friendId");
const removeFriendHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof removeFriendEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const friendDao = new FriendDao(payload.di);
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const result = await friendDao.removeFriend(currentUserId, params.friendId);
    if (result.success) {
      return ResponseUtils.json(200, event, {});
    } else {
      return ResponseUtils.json(400, event, { error: result.error });
    }
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const acceptFriendInvitationByHashEndpoint = Endpoint.build("/api/acceptfriendinvitation", { hash: "string" });
const acceptFriendInvitationByHashHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof acceptFriendInvitationByHashEndpoint
> = async ({ payload, match: { params } }) => {
  const { event } = payload;
  const host = ResponseUtils.getHost(event);
  const friendDao = new FriendDao(payload.di);
  const result = await friendDao.acceptInvitationByHash(params.hash);
  const redirectUrl = host ? UrlUtils.build(`https://${host}`) : UrlUtils.build("https://www.liftosaur.com");
  if (result.success) {
    redirectUrl.searchParams.set("messagesuccess", result.data);
  } else {
    redirectUrl.searchParams.set("messageerror", result.error);
  }
  return { statusCode: 303, body: "Redirecting...", headers: { Location: redirectUrl.toString() } };
};

export const getFriendsHistoryEndpoint = Endpoint.build("/api/friendshistory", {
  startdate: "string",
  enddate: "string?",
});
const getFriendsHistoryHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getFriendsHistoryEndpoint
> = async ({ payload, match: { params } }) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const friendDao = new FriendDao(payload.di);
    const friends = await friendDao.getFriendsWithHistories(currentUserId, params.startdate, params.enddate);
    return ResponseUtils.json(200, event, { friends: CollectionUtils.groupByKeyUniq(friends, "id") });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const getCommentsEndpoint = Endpoint.build("/api/comments", {
  startdate: "string",
  enddate: "string?",
});
const getCommentsHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getCommentsEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const commentsDao = new CommentsDao(payload.di);
    const comments = await commentsDao.getForUser(currentUserId, params.startdate, params.enddate);
    return ResponseUtils.json(200, event, { comments });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const postCommentEndpoint = Endpoint.build("/api/comments");
const postCommentHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof postCommentEndpoint> = async ({
  payload,
}) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const body = getBodyJson(event);
    const commentsDao = new CommentsDao(payload.di);
    const comment = await commentsDao.post(currentUserId, body);
    return ResponseUtils.json(200, event, { comment });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const deleteCommentEndpoint = Endpoint.build("/api/comments/:id");
const deleteCommentHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof deleteCommentEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const commentsDao = new CommentsDao(payload.di);
    await commentsDao.remove(currentUserId, params.id);
    return ResponseUtils.json(200, event, {});
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const deleteAccountEndpoint = Endpoint.build("/api/deleteaccount");
const deleteAccountHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof deleteAccountEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const userDao = new UserDao(payload.di);
    await userDao.removeUser(currentUserId);
    return ResponseUtils.json(200, event, { data: "ok" });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const getLikesEndpoint = Endpoint.build("/api/likes", {
  startdate: "string",
  enddate: "string?",
});
const getLikesHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getLikesEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const likesDao = new LikesDao(payload.di);
    const likes = await likesDao.getForUser(currentUserId, params.startdate, params.enddate);
    return ResponseUtils.json(200, event, { likes });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

export const toggleLikeEndpoint = Endpoint.build("/api/likes/:friendId/:historyRecordId|i");
const toggleLikeHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof toggleLikeEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event } = payload;
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId != null) {
    const likesDao = new LikesDao(payload.di);
    const result = await likesDao.toggle(currentUserId, {
      friendId: params.friendId,
      historyRecordId: params.historyRecordId,
    });
    return ResponseUtils.json(200, event, { result });
  } else {
    return ResponseUtils.json(401, event, {});
  }
};

const getProgramDetailsEndpoint = Endpoint.build("/programs/:id");
const getProgramDetailsHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getProgramDetailsEndpoint
> = async ({ payload, match: { params } }) => {
  const { di } = payload;
  const result = await new ProgramDao(di).getAll();
  if (result != null) {
    return {
      statusCode: 200,
      body: renderProgramDetailsHtml(
        result.map((p) => p.program),
        params.id,
        di.fetch
      ),
      headers: { "content-type": "text/html" },
    };
  } else {
    return { statusCode: 404, body: "Not Found", headers: { "content-type": "text/html" } };
  }
};

const getFreeformEndpoint = Endpoint.build("/freeform");
const getFreeformHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getFreeformEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const di = payload.di;
  return {
    statusCode: 200,
    body: renderFreeformHtml(di.fetch),
    headers: { "content-type": "text/html" },
  };
};

const postPlannerReformatterEndpoint = Endpoint.build("/api/plannerreformatter");
const postPlannerReformatterHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postPlannerReformatterEndpoint
> = async ({ payload }) => {
  const { event, di } = payload;
  const { prompt } = getBodyJson(event);
  const plannerReformatter = new PlannerReformatter(di);
  const result = await plannerReformatter.generate(prompt);
  if (result.success) {
    return ResponseUtils.json(200, event, { data: result.data });
  } else {
    return ResponseUtils.json(400, event, { error: result.error });
  }
};

const postPlannerReformatterFullEndpoint = Endpoint.build("/api/plannerreformatterfull");
const postPlannerReformatterFullHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postPlannerReformatterEndpoint
> = async ({ payload }) => {
  const { event, di } = payload;
  const { prompt } = getBodyJson(event);
  const plannerReformatter = new PlannerReformatter(di);
  const result = await plannerReformatter.generateFull(prompt);
  if (result.success) {
    return ResponseUtils.json(200, event, { data: result.data });
  } else {
    return ResponseUtils.json(400, event, { error: result.error });
  }
};

const postFreeformGeneratorEndpoint = Endpoint.build("/api/freeform");
const postFreeformGeneratorHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postFreeformGeneratorEndpoint
> = async ({ payload }) => {
  const env = Utils.getEnv();
  const { event, di } = payload;
  const bodyJson = getBodyJson(event);
  const id = UidFactory.generateUid(8);
  if (process.env.LOCAL_CHATGPT === "true") {
    freeformLambdaHandler(di)({ prompt: bodyJson.prompt, id: id });
  } else {
    await di.lambda.invoke<ILftFreeformLambdaDevEvent>({
      name: `LftFreeformLambda${env === "dev" ? "Dev" : ""}`,
      invocationType: "Event",
      payload: { prompt: bodyJson.prompt, id: id },
    });
  }
  return ResponseUtils.json(200, event, { id: id });
};

const getFreeformRecordEndpoint = Endpoint.build("/api/freeform/:id");
const getFreeformRecordHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getFreeformRecordEndpoint
> = async ({ payload, match: { params } }) => {
  const { event, di } = payload;
  const id = params.id;
  const logFreeformDao = new LogFreeformDao(di);
  const result = await logFreeformDao.get(id);
  if (result) {
    const program = result.program;
    if (result.type === "data" && program) {
      return ResponseUtils.json(200, event, { program: program, response: result.response });
    } else {
      return ResponseUtils.json(400, event, {
        error: result.error,
        response: result.response,
      });
    }
  } else {
    return ResponseUtils.json(404, event, {});
  }
};

const getPlannerEndpoint = Endpoint.build("/planner", { data: "string?" });
const getPlannerHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getPlannerEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { di } = payload;
  let initialProgram: IExportedPlannerProgram | undefined;
  const data = params.data;
  if (data) {
    try {
      const initialProgramJson = await NodeEncoder.decode(data);
      initialProgram = JSON.parse(initialProgramJson);
    } catch (e) {
      di.log.log(e);
    }
  }
  const userResult = await getUserAccount(payload);
  const account = userResult.success ? userResult.data.account : undefined;
  const user = userResult.success ? userResult.data.user : undefined;

  return {
    statusCode: 200,
    body: renderPlannerHtml(di.fetch, initialProgram, account, user?.storage),
    headers: { "content-type": "text/html" },
  };
};

const getMainEndpoint = Endpoint.build("/main");
const getMainHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getMainEndpoint> = async ({ payload }) => {
  const di = payload.di;
  let account: IAccount | undefined;
  const userResult = await getUserAccount(payload, { withPrograms: true });
  if (userResult.success) {
    ({ account } = userResult.data);
  }

  return {
    statusCode: 200,
    body: renderMainHtml(di.fetch, account),
    headers: { "content-type": "text/html" },
  };
};

const getProgramEndpoint = Endpoint.build("/program", { data: "string?" });
const getProgramHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getProgramEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const di = payload.di;
  const data = params.data;
  let program: IExportedProgram | undefined;
  const isMobile = Mobile.isMobile(payload.event.headers["user-agent"] || payload.event.headers["User-Agent"] || "");
  let user: ILimitedUserDao | undefined;
  let account: IAccount | undefined;
  const userResult = await getUserAccount(payload, { withPrograms: true });
  if (userResult.success) {
    ({ user, account } = userResult.data);
  }
  const storage = user?.storage ? await runMigrations(di.fetch, user.storage) : undefined;

  if (data) {
    try {
      const exportedProgramJson = await NodeEncoder.decode(data);
      const result = await ImportExporter.getExportedProgram(di.fetch, exportedProgramJson);
      if (result.success) {
        program = result.data;
      } else {
        di.log.log(result.error);
      }
    } catch (e) {
      di.log.log(e);
    }
  }

  return {
    statusCode: 200,
    body: renderProgramHtml(di.fetch, isMobile, false, program, account, storage),
    headers: { "content-type": "text/html" },
  };
};

const getUserProgramsEndpoint = Endpoint.build("/user/programs");
const getUserProgramsHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getUserProgramsEndpoint> = async ({
  payload,
}) => {
  const di = payload.di;
  const isMobile = Mobile.isMobile(payload.event.headers["user-agent"] || payload.event.headers["User-Agent"] || "");
  const userResult = await getUserAccount(payload, { withPrograms: true });
  if (!userResult.success) {
    return userResult.error;
  }
  const { account, user } = userResult.data;
  const storage = await runMigrations(di.fetch, user.storage);

  return {
    statusCode: 200,
    body: renderProgramsListHtml(di.fetch, isMobile, account, storage),
    headers: { "content-type": "text/html" },
  };
};

async function getUserAccount(
  payload: IPayload,
  args: { withPrograms?: boolean } = {}
): Promise<IEither<{ user: ILimitedUserDao; account: IAccount }, APIGatewayProxyResult>> {
  const currentUserId = await getCurrentUserId(payload.event, payload.di);
  if (currentUserId == null) {
    const result: APIGatewayProxyResult = {
      statusCode: 302,
      body: "",
      headers: { "content-type": "text/html", location: "/program" },
    };
    return { success: false, error: result };
  }
  const userDao = new UserDao(payload.di);
  const user = await userDao.getLimitedById(currentUserId);
  if (!user) {
    const result = {
      statusCode: 404,
      body: "Not Found",
      headers: { "content-type": "text/html" },
    };
    return { success: false, error: result };
  }
  const programs = args.withPrograms ? await userDao.getProgramsByUserId(user.id) : undefined;
  user.storage.programs = programs;
  const account = Account.getFromStorage(user.id, user.email, user.storage);
  return { success: true, data: { user, account } };
}

const postUserPlannerProgramEndpoint = Endpoint.build("/api/userplannerprogram");
const postUserPlannerProgramHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postUserPlannerProgramEndpoint
> = async ({ payload }) => {
  const { event, di } = payload;
  const currentUserId = await getCurrentUserId(event, di);
  if (currentUserId == null) {
    return ResponseUtils.json(401, event, { error: "not_authorized" });
  }
  const userDao = new UserDao(di);
  const user = await userDao.getLimitedById(currentUserId);
  if (user == null) {
    return ResponseUtils.json(404, event, { error: "not_found" });
  }
  const bodyJson = getBodyJson(event);
  const exportedPlannerProgram: IExportedPlannerProgram = bodyJson.program;
  user.storage.settings = {
    ...user.storage.settings,
    exercises: {
      ...user.storage.settings.exercises,
      ...exportedPlannerProgram.settings.exercises,
    },
  };
  const oldProgram = Program.create(exportedPlannerProgram.program.name, exportedPlannerProgram.id);
  const program = new PlannerToProgram(
    oldProgram.id,
    oldProgram.nextDay,
    oldProgram.exercises,
    exportedPlannerProgram.program,
    user.storage.settings
  ).convertToProgram();

  await userDao.store(user);
  await userDao.saveProgram(user.id, program);

  return ResponseUtils.json(200, event, { id: program.id });
};

const getUserProgramEndpoint = Endpoint.build("/user/p/:programid");
const getUserProgramHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getUserProgramEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const di = payload.di;
  const isMobile = Mobile.isMobile(payload.event.headers["user-agent"] || payload.event.headers["User-Agent"] || "");
  const userResult = await getUserAccount(payload, { withPrograms: true });
  if (!userResult.success) {
    return userResult.error;
  }
  const { account, user } = userResult.data;
  const storage = await runMigrations(di.fetch, user.storage);
  const exportedProgram = Program.storageToExportedProgram(storage, params.programid);
  if (!exportedProgram) {
    return {
      statusCode: 404,
      body: "Not Found",
      headers: { "content-type": "text/html" },
    };
  }

  return {
    statusCode: 200,
    body: renderProgramHtml(di.fetch, isMobile, true, exportedProgram, account, storage),
    headers: { "content-type": "text/html" },
  };
};

const getAffiliatesEndpoint = Endpoint.build("/affiliates");
const getAffiliatesHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof getAffiliatesEndpoint> = async ({
  payload,
  match,
}) => {
  const di = payload.di;
  const userResult = await getUserAccount(payload);
  const account = userResult.success ? userResult.data.account : undefined;
  return {
    statusCode: 200,
    body: renderAffiliatesHtml(di.fetch, account),
    headers: { "content-type": "text/html" },
  };
};

const getProgramShorturlResponseEndpoint = Endpoint.build("/api/p/:id");
const getProgramShorturlResponseHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getProgramShorturlEndpoint
> = async ({ payload, match: { params } }) => {
  return _getProgramShorturlResponseHandler(payload.di, payload.event, params.id);
};

const getPlannerShorturlResponseEndpoint = Endpoint.build("/api/n/:id");
const getPlannerShorturlResponseHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getPlannerShorturlResponseEndpoint
> = async ({ payload, match: { params } }) => {
  return _getProgramShorturlResponseHandler(payload.di, payload.event, params.id);
};

const getPlanShorturlResponseEndpoint = Endpoint.build("/api/b/:id");
const getPlanShorturlResponseHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getPlanShorturlResponseEndpoint
> = async ({ payload, match: { params } }) => {
  return _getProgramShorturlResponseHandler(payload.di, payload.event, params.id);
};

async function _getProgramShorturlResponseHandler(
  di: IDI,
  event: APIGatewayProxyEvent,
  id: string
): Promise<APIGatewayProxyResult> {
  const urlString = await new UrlDao(di).get(id);
  if (urlString) {
    const url = UrlUtils.build(urlString, "https://www.liftosaur.com");
    const data = url.searchParams.get("data");
    const s = url.searchParams.get("s");
    if (data) {
      return ResponseUtils.json(200, event, { data, s });
    } else {
      return ResponseUtils.json(401, event, {});
    }
  }
  return ResponseUtils.json(404, event, {});
}

const postClaimFreeUserEndpoint = Endpoint.build("/api/claimkey/:userid");
const postClaimFreeUserHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postClaimFreeUserEndpoint
> = async ({ payload, match: { params } }) => {
  const { di, event } = payload;
  const userid = params.userid;
  const claim = await new FreeUserDao(di).claim(userid);
  return ResponseUtils.json(200, event, { data: { claim } });
};

const postStoreExceptionDataEndpoint = Endpoint.build("/api/exception");
const postStoreExceptionDataHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof postStoreExceptionDataEndpoint
> = async ({ payload }) => {
  const { di, event } = payload;
  const bodyJson = getBodyJson(event);
  const { id, data } = bodyJson;
  const exceptionDao = new ExceptionDao(di);
  await exceptionDao.store(id, JSON.stringify(data));
  return ResponseUtils.json(200, event, { data: { id } });
};

const getStoreExceptionDataEndpoint = Endpoint.build("/api/exception/:id");
const getStoreExceptionDataHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getStoreExceptionDataEndpoint
> = async ({ payload, match: { params } }) => {
  const { di, event } = payload;
  const id = params.id;
  const exceptionDao = new ExceptionDao(di);
  const data = await exceptionDao.get(id);
  if (data) {
    return ResponseUtils.json(200, event, { data });
  } else {
    return ResponseUtils.json(404, event, { error: "Not Found" });
  }
};

const getPlannerShorturlEndpoint = Endpoint.build("/n/:id");
const getPlannerShorturlHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getPlannerShorturlEndpoint
> = async ({ payload, match: { params } }) => {
  const di = payload.di;
  const id = params.id;
  return shorturlRedirect(di, id);
};

const getProgramShorturlEndpoint = Endpoint.build("/p/:id");
const getProgramShorturlHandler: RouteHandler<
  IPayload,
  APIGatewayProxyResult,
  typeof getProgramShorturlEndpoint
> = async ({ payload, match: { params } }) => {
  const di = payload.di;
  const id = params.id;
  const env = Utils.getEnv();
  let program: IExportedProgram | undefined;
  const isMobile = Mobile.isMobile(payload.event.headers["user-agent"] || payload.event.headers["User-Agent"] || "");
  const urlString = await new UrlDao(di).get(id);
  if (urlString) {
    const url = UrlUtils.build(urlString, "https://www.liftosaur.com");
    const data = url.searchParams.get("data");
    if (data) {
      try {
        const exportedProgramJson = await NodeEncoder.decode(data);
        const result = await ImportExporter.getExportedProgram(di.fetch, exportedProgramJson);
        if (result.success) {
          program = result.data;
          if (program?.program.planner != null) {
            const host =
              env === "dev"
                ? Utils.isLocal()
                  ? "local.liftosaur.com:8080"
                  : "stage.liftosaur.com"
                : "www.liftosaur.com";
            const redirectUrl = UrlUtils.build(`https://${host}`);
            redirectUrl.pathname = "/planner";
            const exportedProgram: IExportedPlannerProgram = {
              id: program.program.id,
              program: program.program.planner,
              type: "v2",
              version: getLatestMigrationVersion(),
              settings: {
                exercises: program.customExercises,
                timer: program.settings.timers.workout ?? 180,
              },
            };
            redirectUrl.searchParams.set("data", await NodeEncoder.encode(JSON.stringify(exportedProgram)));
            return { statusCode: 303, body: "Redirecting...", headers: { Location: redirectUrl.toString() } };
          }

          let user: ILimitedUserDao | undefined;
          let account: IAccount | undefined;
          const userResult = await getUserAccount(payload, { withPrograms: true });
          if (userResult.success) {
            ({ user, account } = userResult.data);
          }
          const storage = user?.storage ? await runMigrations(di.fetch, user.storage) : undefined;

          return {
            statusCode: 200,
            body: renderProgramHtml(di.fetch, isMobile, false, program, account, storage),
            headers: { "content-type": "text/html" },
          };
        } else {
          di.log.log(result.error);
        }
      } catch (e) {
        di.log.log(e);
      }
    }
  }
  return ResponseUtils.json(404, payload.event, { error: "Not Found" });
};

async function shorturlRedirect(di: IDI, id: string): Promise<APIGatewayProxyResult> {
  const url = await new UrlDao(di).get(id);
  if (url) {
    const header: Record<string, string> = { location: url, "content-type": "text/html" };
    return {
      statusCode: 302,
      body: "",
      headers: header,
    };
  } else {
    const header: Record<string, string> = { "content-type": "text/html" };
    return {
      statusCode: 404,
      body: "Not Found",
      headers: header,
    };
  }
}

const postShortUrlEndpoint = Endpoint.build("/shorturl/:type");
const postShortUrlHandler: RouteHandler<IPayload, APIGatewayProxyResult, typeof postShortUrlEndpoint> = async ({
  payload,
  match: { params },
}) => {
  const { event, di } = payload;
  const { type } = params;
  const { url } = getBodyJson(event);
  if (url == null || typeof url !== "string") {
    return ResponseUtils.json(400, event, {});
  }
  const id = await new UrlDao(di).put(url);
  const newUrl = `/${type}/${id}`;

  return ResponseUtils.json(200, event, { url: newUrl });
};

// async function loadBackupHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
//   const json = JSON.parse(fs.readFileSync("json.json", "utf-8"));

//   for (const userId in json.users) {
//     if (json.users.hasOwnProperty(userId)) {
//       const { storage, email } = JSON.parse(json.users[userId]) as { storage: IStorage; email: string };
//       if (storage != null) {
//         const googleId = Object.keys(json.google_ids).find((k) => json.google_ids[k] === userId);
//         const user = UserDao.build(userId, googleId!, email);
//         await UserDao.store(user);
//         await UserDao.saveStorage(user, storage);
//       } else {
//         console.error("There's no storage for", userId);
//       }
//     }
//   }

//   for (const token in json.google_access_tokens) {
//     if (json.google_access_tokens.hasOwnProperty(token)) {
//       const googleId = json.google_access_tokens[token];
//       await GoogleAuthTokenDao.store(Utils.getEnv(), token, googleId);
//     }
//   }

//   for (const programId in json.programs) {
//     if (json.programs.hasOwnProperty(programId)) {
//       const { program, timestamp } = JSON.parse(json.programs[programId]) as {
//         program: IProgram;
//         timestamp: number;
//       };
//       await ProgramDao.save(program, timestamp);
//     }
//   }

//   return {
//     statusCode: 200,
//     body: JSON.stringify({ data: "ok" }),
//     headers: getHeaders(event),
//   };
// }

// async function storePrograms(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
//   for (const programPayload of programsJson) {
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     await ProgramDao.add(programPayload as any);
//   }
//   return { statusCode: 200, body: "{}", headers: getHeaders(event) };
// }

const rollbar = new Rollbar({
  accessToken: "bcdd086a019f49edb69f790a854b44dd",
  captureUncaught: true,
  captureUnhandledRejections: true,
  payload: {
    environment: `${Utils.getEnv()}-lambda`,
    client: {
      javascript: {
        source_map_enabled: true,
        code_version: process.env.FULL_COMMIT_HASH,
        guess_uncaught_frames: true,
      },
    },
  },
  checkIgnore: RollbarUtils.checkIgnore,
});

type ILftFreeformLambdaDevEvent = { prompt: string; id: string };

export const getLftFreeformLambdaDev = (di: IDI): Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown> =>
  rollbar.lambdaHandler(
    async (event: ILftFreeformLambdaDevEvent): Promise<APIGatewayProxyResult> => freeformLambdaHandler(di)(event)
  ) as Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown>;

export const getLftFreeformLambda = (di: IDI): Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown> =>
  rollbar.lambdaHandler(
    async (event: ILftFreeformLambdaDevEvent): Promise<APIGatewayProxyResult> => freeformLambdaHandler(di)(event)
  ) as Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown>;

export const getLftStatsLambdaDev = (di: IDI): Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown> =>
  rollbar.lambdaHandler(
    async (event: {}): Promise<APIGatewayProxyResult> => statsLambdaHandler(di)(event)
  ) as Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown>;

export const getLftStatsLambda = (di: IDI): Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown> =>
  rollbar.lambdaHandler(
    async (event: {}): Promise<APIGatewayProxyResult> => statsLambdaHandler(di)(event)
  ) as Rollbar.LambdaHandler<unknown, APIGatewayProxyResult, unknown>;

export const statsLambdaHandler = (di: IDI): ((event: {}) => Promise<APIGatewayProxyResult>) => {
  return async () => {
    const lastThreeMonths = [DateUtils.yearAndMonth(Date.now())];
    const lastMonthlogRecords = await new LogDao(di).getAllForYearAndMonth(
      lastThreeMonths[0][0],
      lastThreeMonths[0][1]
    );
    const userIds = lastMonthlogRecords.filter((r) => r.action === "ls-finish-workout").map((r) => r.userId);
    const users = await new UserDao(di).getLimitedByIds(userIds);
    const usersById = CollectionUtils.groupByKeyUniq(users, "id");
    const logRecords = CollectionUtils.sortBy(await new LogDao(di).getForUsers(userIds), "ts", true);
    const logRecordsByUserId = CollectionUtils.groupByKey(logRecords, "userId");

    const usersData: IStatsUserData[] = Object.keys(logRecordsByUserId).map((userId) => {
      const userLogRecords = CollectionUtils.sortBy(logRecordsByUserId[userId] || [], "ts", true);
      const lastAction = userLogRecords[0];
      const firstAction = userLogRecords[userLogRecords.length - 1];
      return {
        userId,
        email: usersById[userId]?.email,
        userTs: usersById[userId]?.createdAt,
        firstAction: { name: firstAction.action, ts: firstAction.ts },
        lastAction: { name: lastAction.action, ts: lastAction.ts },
      };
    });

    let lastDay;
    const data: IStatsUserData[][] = [];
    for (const user of usersData) {
      const day = new Date(user.lastAction.ts).getUTCDate();
      if (lastDay == null || lastDay !== day) {
        data.push([]);
        lastDay = day;
      }
      const dayGroup = data[data.length - 1];
      dayGroup.push(user);
    }

    for (const dayGroup of data) {
      dayGroup.sort((a, b) => {
        const isANew = getIsNew(a);
        const isANewUser = getIsNewUser(a);
        const isBNew = getIsNew(b);
        const isBNewUser = getIsNewUser(b);

        if ((isANew || isANewUser) && !(isBNew || isBNewUser)) {
          return -1;
        } else if (!(isANew || isANewUser) && (isBNew || isBNewUser)) {
          return 1;
        } else {
          return b.lastAction.ts - a.lastAction.ts;
        }
      });
    }

    const activeMontlyCount = data.reduce((acc, dayGroup) => acc + dayGroup.length, 0);
    const activeMonthlyRegisteredCount = data.reduce(
      (acc, dayGroup) => acc + dayGroup.filter((i) => i.email != null).length,
      0
    );
    const newThisMonth = data.reduce(
      (acc, dayGroup) => acc + dayGroup.filter((i) => Date.now() - i.firstAction.ts < 1000 * 60 * 60 * 24 * 30).length,
      0
    );
    const newRegisteredThisMonth = data.reduce(
      (acc, dayGroup) =>
        acc + dayGroup.filter((i) => i.userTs != null && Date.now() - i.userTs < 1000 * 60 * 60 * 24 * 30).length,
      0
    );

    const dayGroup = data[0];
    const activeCount = dayGroup.length;
    const activeRegisteredCount = dayGroup.filter((i) => i.email != null).length;
    const newThisDay = dayGroup.filter((i) => Date.now() - i.firstAction.ts < 1000 * 60 * 60 * 24).length;
    const newRegisteredThisDay = dayGroup.filter((i) => i.userTs != null && Date.now() - i.userTs < 1000 * 60 * 60 * 24)
      .length;

    const bucket = `${LftS3Buckets.stats}${Utils.getEnv() === "dev" ? "dev" : ""}`;
    const statsFile = await di.s3.getObject({ bucket, key: "stats.csv" });
    let stats = statsFile?.toString();
    if (!stats) {
      stats =
        "date,monthly,monthly_registered,monthly_new,monthly_new_registered,daily,daily_registered,daily_new,daily_new_registered\n";
    }
    stats += `${DateUtils.formatYYYYMMDD(
      new Date()
    )},${activeMontlyCount},${activeMonthlyRegisteredCount},${newThisMonth},${newRegisteredThisMonth},${activeCount},${activeRegisteredCount},${newThisDay},${newRegisteredThisDay}\n`;
    await di.s3.putObject({
      bucket: bucket,
      key: "stats.csv",
      body: stats,
      opts: { contentType: "text/csv" },
    });
    console.log(stats);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: "done",
      }),
    };
  };
};

function getIsNew(item: IStatsUserData): boolean {
  const firstActionDate = new Date(item.firstAction.ts);
  const lastActionDate = new Date(item.lastAction.ts);
  return (
    firstActionDate.getUTCFullYear() === lastActionDate.getUTCFullYear() &&
    firstActionDate.getUTCMonth() === lastActionDate.getUTCMonth() &&
    firstActionDate.getUTCDate() === lastActionDate.getUTCDate()
  );
}

function getIsNewUser(item: IStatsUserData): boolean {
  const lastActionDate = new Date(item.lastAction.ts);
  const userDate = item.userTs && new Date(item.userTs);
  return !!(
    userDate &&
    userDate.getUTCFullYear() === lastActionDate.getUTCFullYear() &&
    userDate.getUTCMonth() === lastActionDate.getUTCMonth() &&
    userDate.getUTCDate() === lastActionDate.getUTCDate()
  );
}

export const freeformLambdaHandler = (
  di: IDI
): ((event: ILftFreeformLambdaDevEvent) => Promise<APIGatewayProxyResult>) => {
  return async (event) => {
    di.log.log("Start generating freeform program");
    const freeformGenerator = new FreeformGenerator(di);
    const result = await freeformGenerator.generate(event.prompt);
    if (result.success) {
      await new LogFreeformDao(di).put(event.id, "data", event.prompt, result.data.response, {
        program: result.data.program,
      });
      di.log.log("Done generating freeform program");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "done" }),
      };
    } else {
      await new LogFreeformDao(di).put(event.id, "error", event.prompt, result.error.response, {
        error: result.error.error,
      });
      di.log.log("Error generating freeform program");
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "error" }),
      };
    }
  };
};

export type IHandler = (event: APIGatewayProxyEvent, context: unknown) => Promise<APIGatewayProxyResult>;
type IRollbarHandler = Rollbar.LambdaHandler<APIGatewayProxyEvent, APIGatewayProxyResult, unknown>;
export const getHandler = (di: IDI): IRollbarHandler => {
  return rollbar.lambdaHandler(getRawHandler(di));
};

export const getRawHandler = (di: IDI): IHandler => {
  return async (event: APIGatewayProxyEvent, context) => {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, body: "", headers: ResponseUtils.getHeaders(event) };
    }
    const time = Date.now();
    const userid = await getCurrentUserId(event, di);
    if (userid) {
      di.log.setUser(userid);
    }
    di.log.log("--------> Starting request", event.httpMethod, event.path);
    di.log.log("User Agent:", event.headers["user-agent"] || event.headers["User-Agent"] || "");
    const request: IPayload = { event, di };
    const r = new Router<IPayload, APIGatewayProxyResult>(request)
      .get(getMainEndpoint, getMainHandler)
      .get(getStoreExceptionDataEndpoint, getStoreExceptionDataHandler)
      .post(postStoreExceptionDataEndpoint, postStoreExceptionDataHandler)
      .get(getProgramShorturlEndpoint, getProgramShorturlHandler)
      .get(getPlannerShorturlEndpoint, getPlannerShorturlHandler)
      .get(getProgramShorturlResponseEndpoint, getProgramShorturlResponseHandler)
      .get(getPlannerShorturlResponseEndpoint, getPlannerShorturlResponseHandler)
      .get(getPlanShorturlResponseEndpoint, getPlanShorturlResponseHandler)
      .get(getDashboardsAffiliatesEndpoint, getDashboardsAffiliatesHandler)
      .get(getFreeformEndpoint, getFreeformHandler)
      .get(getFreeformRecordEndpoint, getFreeformRecordHandler)
      .post(postPlannerReformatterEndpoint, postPlannerReformatterHandler)
      .post(postPlannerReformatterFullEndpoint, postPlannerReformatterFullHandler)
      .post(postFreeformGeneratorEndpoint, postFreeformGeneratorHandler)
      .get(getDashboardsUsersEndpoint, getDashboardsUsersHandler)
      .get(getAffiliatesEndpoint, getAffiliatesHandler)
      .post(postShortUrlEndpoint, postShortUrlHandler)
      .post(postAddFreeUserEndpoint, postAddFreeUserHandler)
      .post(postClaimFreeUserEndpoint, postClaimFreeUserHandler)
      .get(getStorageEndpoint, getStorageHandler)
      .get(getPlannerEndpoint, getPlannerHandler)
      .get(getProgramEndpoint, getProgramHandler)
      .get(getUserProgramsEndpoint, getUserProgramsHandler)
      .get(getUserProgramEndpoint, getUserProgramHandler)
      .post(postVerifyAppleReceiptEndpoint, postVerifyAppleReceiptHandler)
      .post(postVerifyGooglePurchaseTokenEndpoint, postVerifyGooglePurchaseTokenHandler)
      .post(googleLoginEndpoint, googleLoginHandler)
      .post(appleLoginEndpoint, appleLoginHandler)
      .post(signoutEndpoint, signoutHandler)
      .get(getProgramsEndpoint, getProgramsHandler)
      .post(saveStorageEndpoint, saveStorageHandler)
      .post(saveDebugStorageEndpoint, saveDebugStorageHandler)
      .get(getHistoryRecordEndpoint, getHistoryRecordHandler)
      .get(getHistoryRecordImageEndpoint, getHistoryRecordImageHandler)
      .post(logEndpoint, logHandler)
      .post(publishProgramEndpoint, publishProgramHandler)
      .get(getProfileEndpoint, getProfileHandler)
      .get(getProfileImageEndpoint, getProfileImageHandler)
      .get(getAdminUsersEndpoint, getAdminUsersHandler)
      .get(getAdminLogsEndpoint, getAdminLogsHandler)
      .get(getFriendsEndpoint, getFriendsHandler)
      .post(inviteFriendEndpoint, inviteFriendHandler)
      .get(acceptFriendInvitationByHashEndpoint, acceptFriendInvitationByHashHandler)
      .post(acceptFriendInvitationEndpoint, acceptFriendInvitationHandler)
      .delete(removeFriendEndpoint, removeFriendHandler)
      .get(getFriendsHistoryEndpoint, getFriendsHistoryHandler)
      .get(getCommentsEndpoint, getCommentsHandler)
      .post(postCommentEndpoint, postCommentHandler)
      .delete(deleteCommentEndpoint, deleteCommentHandler)
      .get(getLikesEndpoint, getLikesHandler)
      .post(toggleLikeEndpoint, toggleLikeHandler)
      .get(getProgramDetailsEndpoint, getProgramDetailsHandler)
      .get(getProgramImageEndpoint, getProgramImageHandler)
      .post(postCreateCouponEndpoint, postCreateCouponHandler)
      .post(postClaimCouponEndpoint, postClaimCouponHandler)
      .post(saveDebugEndpoint, saveDebugHandler)
      .get(pingEndpoint, pingHandler)
      .delete(deleteAccountEndpoint, deleteAccountHandler)
      .post(postUserPlannerProgramEndpoint, postUserPlannerProgramHandler);
    // r.post(".*/api/loadbackup", loadBackupHandler);
    const url = UrlUtils.build(event.path, "http://example.com");
    for (const key of Object.keys(event.queryStringParameters || {})) {
      const value = (event.queryStringParameters || {})[key];
      url.searchParams.set(key, value || "");
    }
    let resp: IEither<APIGatewayProxyResult, string>;
    let errorStatus = 404;
    try {
      resp = await r.route(event.httpMethod as Method, url.pathname + url.search);
    } catch (e) {
      console.error(e);
      di.log.log(e);
      errorStatus = 500;
      resp = { success: false, error: "Internal Server Error" };
    }
    di.log.log(
      "<-------- Responding for",
      event.httpMethod,
      event.path,
      resp.success ? resp.data.statusCode : errorStatus,
      `${Date.now() - time}ms`
    );
    return resp.success
      ? resp.data
      : { statusCode: errorStatus, headers: ResponseUtils.getHeaders(event), body: resp.error };
  };
};
