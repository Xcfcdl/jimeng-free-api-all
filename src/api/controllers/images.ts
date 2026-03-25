import _ from "lodash";
import crypto from "crypto";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request } from "./core.ts";
import logger from "@/lib/logger.ts";
import { getModelConfig } from "@/lib/configs/model-config.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-4.5";
const DRAFT_VERSION = "3.3.4";
const DRAFT_MIN_VERSION = "3.0.2";

// 支持的图片比例和分辨率配置
const RESOLUTION_OPTIONS: {
  [resolution: string]: {
    [ratio: string]: { width: number; height: number; ratio: number };
  };
} = {
  "1k": {
    "1:1": { width: 1024, height: 1024, ratio: 1 },
    "4:3": { width: 768, height: 1024, ratio: 4 },
    "3:4": { width: 1024, height: 768, ratio: 2 },
    "16:9": { width: 1024, height: 576, ratio: 3 },
    "9:16": { width: 576, height: 1024, ratio: 5 },
    "3:2": { width: 1024, height: 682, ratio: 7 },
    "2:3": { width: 682, height: 1024, ratio: 6 },
    "21:9": { width: 1195, height: 512, ratio: 8 },
  },
  "2k": {
    "1:1": { width: 2048, height: 2048, ratio: 1 },
    "4:3": { width: 2304, height: 1728, ratio: 4 },
    "3:4": { width: 1728, height: 2304, ratio: 2 },
    "16:9": { width: 2560, height: 1440, ratio: 3 },
    "9:16": { width: 1440, height: 2560, ratio: 5 },
    "3:2": { width: 2496, height: 1664, ratio: 7 },
    "2:3": { width: 1664, height: 2496, ratio: 6 },
    "21:9": { width: 3024, height: 1296, ratio: 8 },
  },
  "4k": {
    "1:1": { width: 4096, height: 4096, ratio: 101 },
    "4:3": { width: 4608, height: 3456, ratio: 104 },
    "3:4": { width: 3456, height: 4608, ratio: 102 },
    "16:9": { width: 5120, height: 2880, ratio: 103 },
    "9:16": { width: 2880, height: 5120, ratio: 105 },
    "3:2": { width: 4992, height: 3328, ratio: 107 },
    "2:3": { width: 3328, height: 4992, ratio: 106 },
    "21:9": { width: 6048, height: 2592, ratio: 108 },
  },
};

// 解析分辨率参数
function resolveResolution(
  resolution: string = "2k",
  ratio: string = "1:1"
): { width: number; height: number; imageRatio: number; resolutionType: string } {
  const resolutionGroup = RESOLUTION_OPTIONS[resolution];
  if (!resolutionGroup) {
    const supportedResolutions = Object.keys(RESOLUTION_OPTIONS).join(", ");
    throw new Error(`不支持的分辨率 "${resolution}"。支持的分辨率: ${supportedResolutions}`);
  }

  const ratioConfig = resolutionGroup[ratio];
  if (!ratioConfig) {
    const supportedRatios = Object.keys(resolutionGroup).join(", ");
    throw new Error(`在 "${resolution}" 分辨率下，不支持的比例 "${ratio}"。支持的比例: ${supportedRatios}`);
  }

  return {
    width: ratioConfig.width,
    height: ratioConfig.height,
    imageRatio: ratioConfig.ratio,
    resolutionType: resolution,
  };
}

// 模型特定的版本配置
const MODEL_DRAFT_VERSIONS: { [key: string]: string } = {
  "jimeng-5.0": "3.3.9",
  "jimeng-4.6": "3.3.9",
  "jimeng-4.5": "3.3.4",
  "jimeng-4.1": "3.3.4",
  "jimeng-4.0": "3.3.4",
  "jimeng-3.1": "3.0.2",
  "jimeng-3.0": "3.0.2",
  "jimeng-2.1": "3.0.2",
  "jimeng-2.0-pro": "3.0.2",
  "jimeng-2.0": "3.0.2",
  "jimeng-1.4": "3.0.2",
  "jimeng-xl-pro": "3.0.2",
};

// 获取模型对应的draft版本
function getDraftVersion(model: string): string {
  try {
    const config = getModelConfig(model);
    return config.draftVersion;
  } catch (e) {
    // 如果配置中没有，使用旧的映射
    return MODEL_DRAFT_VERSIONS[model] || DRAFT_VERSION;
  }
}
const MODEL_MAP = {
  "jimeng-5.0": "high_aes_general_v50",
  "jimeng-4.6": "high_aes_general_v42",
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
  "jimeng-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-3.0": "high_aes_general_v30l:general_v3.0_18b",
  "jimeng-2.1": "high_aes_general_v21_L:general_v2.1_L",
  "jimeng-2.0-pro": "high_aes_general_v20_L:general_v2.0_L",
  "jimeng-2.0": "high_aes_general_v20:general_v2.0",
  "jimeng-1.4": "high_aes_general_v14:general_v1.4",
  "jimeng-xl-pro": "text2img_xl_sft",
};

// 向后兼容的函数
export function getModel(model: string) {
  try {
    const config = getModelConfig(model);
    return config.internalModel;
  } catch (e) {
    // 如果配置中没有，使用旧的映射
    return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
  }
}


// AWS4-HMAC-SHA256 签名生成函数
function createSignature(
  method: string,
  url: string,
  headers: { [key: string]: string },
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string,
  payload: string = ''
) {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname || '/';
  const search = urlObj.search;
  
  // 创建规范请求
  const timestamp = headers['x-amz-date'];
  const date = timestamp.substr(0, 8);
  const region = 'cn-north-1';
  const service = 'imagex';
  
  // 规范化查询参数 - 手动处理以确保正确的顺序
  const queryParams: Array<[string, string]> = [];
  const searchParams = new URLSearchParams(search);
  searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });
  
  // 按键名排序 - 大小写敏感，先大写字母，后小写字母
  queryParams.sort(([a], [b]) => {
    // AWS要求大小写敏感的ASCII排序
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  
  // 构建规范查询字符串（不进行额外编码，因为URL中已经编码）
  const canonicalQueryString = queryParams
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  
  // 规范化头部 - 只包含必要的头部
  const headersToSign: { [key: string]: string } = {
    'x-amz-date': timestamp
  };
  
  // 添加 session token
  if (sessionToken) {
    headersToSign['x-amz-security-token'] = sessionToken;
  }
  
  // 如果是POST请求且包含payload，添加content-sha256头
  let payloadHash = crypto.createHash('sha256').update('').digest('hex'); // 默认空payload
  if (method.toUpperCase() === 'POST' && payload) {
    payloadHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    headersToSign['x-amz-content-sha256'] = payloadHash;
  }
  
  const signedHeaders = Object.keys(headersToSign)
    .map(key => key.toLowerCase())
    .sort()
    .join(';');
  
  const canonicalHeaders = Object.keys(headersToSign)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(key => `${key.toLowerCase()}:${headersToSign[key].trim()}\n`)
    .join('');
  
  // 创建规范请求
  const canonicalRequest = [
    method.toUpperCase(),
    pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // 调试输出
  logger.debug(`规范请求:
Method: ${method.toUpperCase()}
Path: ${pathname}
Query: ${canonicalQueryString}
Headers: ${canonicalHeaders}
SignedHeaders: ${signedHeaders}
PayloadHash: ${payloadHash}
---完整规范请求---
${canonicalRequest}
---结束---`);
  
  // 创建待签名字符串
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n');
  
  logger.debug(`待签名字符串:
${stringToSign}`);
  
  // 生成签名
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// 计算文件的CRC32值
function calculateCRC32(data: Buffer | ArrayBuffer | Uint8Array): string {
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    crcTable[i] = crc;
  }
  
  let crc = 0 ^ (-1);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return ((crc ^ (-1)) >>> 0).toString(16).padStart(8, '0');
}


// 图片上传功能：由Buffer直接上传
async function uploadImageBuffer(buffer: Buffer | ArrayBuffer, refreshToken: string, filename: string = "image.jpg"): Promise<string> {
  try {
    const fileSize = buffer.byteLength;
    logger.info(`开始上传图片Buffer: ${filename}, 大小=${fileSize}字节`);
    
    // 确保 buffer 是 ArrayBuffer
    const arrayBuffer: any = buffer instanceof Buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer;
    const crc32 = calculateCRC32(arrayBuffer);

    // 第一步：获取上传令牌
    const tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {
      data: {
        scene: 2, // AIGC 图片上传场景
      },
    });
    
    const { access_key_id, secret_access_key, session_token, service_id } = tokenResult;
    if (!access_key_id || !secret_access_key || !session_token) {
      throw new Error("获取上传令牌失败");
    }
    
    const actualServiceId = service_id || "tb4s082cfz";
    logger.info(`获取上传令牌成功: service_id=${actualServiceId}`);
    
    // 第二步：申请图片上传权限
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const randomStr = Math.random().toString(36).substring(2, 12);
    const applyUrl = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}&FileSize=${fileSize}&s=${randomStr}`;
    
    const requestHeaders = {
      'x-amz-date': timestamp,
      'x-amz-security-token': session_token
    };
    
    const authorization = createSignature('GET', applyUrl, requestHeaders, access_key_id, secret_access_key, session_token);
    
    const applyResponse = await fetch(applyUrl, {
      method: 'GET',
      headers: {
        'accept': '*/*',
        'authorization': authorization,
        'origin': 'https://jimeng.jianying.com',
        'referer': 'https://jimeng.jianying.com/ai-tool/generate',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'x-amz-date': timestamp,
        'x-amz-security-token': session_token,
      },
    });
    
    if (!applyResponse.ok) {
      const errorText = await applyResponse.text();
      throw new Error(`申请上传权限失败: ${applyResponse.status} - ${errorText}`);
    }
    
    const applyResult = await applyResponse.json();
    if (applyResult?.ResponseMetadata?.Error) {
      throw new Error(`申请上传权限失败: ${JSON.stringify(applyResult.ResponseMetadata.Error)}`);
    }
    
    const uploadAddress = applyResult?.Result?.UploadAddress;
    if (!uploadAddress || !uploadAddress.StoreInfos || !uploadAddress.UploadHosts) {
      throw new Error(`获取上传地址失败: ${JSON.stringify(applyResult)}`);
    }
    
    const storeInfo = uploadAddress.StoreInfos[0];
    const uploadHost = uploadAddress.UploadHosts[0];
    const auth = storeInfo.Auth;
    const uploadUrl = `https://${uploadHost}/upload/v1/${storeInfo.StoreUri}`;
    const imageId = storeInfo.StoreUri.split('/').pop();
    
    logger.info(`准备上传图片文件: imageId=${imageId}, uploadUrl=${uploadUrl}`);
    
    // 第三步：上传图片文件内容
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Authorization': auth,
        'Content-CRC32': crc32,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': 'application/octet-stream',
        'Origin': 'https://jimeng.jianying.com',
        'Referer': 'https://jimeng.jianying.com/ai-tool/generate',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      },
      body: arrayBuffer as any,
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`图片文件上传失败: ${uploadResponse.status} - ${errorText}`);
    }
    
    // 第四步：提交上传
    const commitUrl = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}`;
    const commitTimestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const commitPayload = JSON.stringify({
      SessionKey: uploadAddress.SessionKey,
      SuccessActionStatus: "200"
    });
    
    const payloadHash = crypto.createHash('sha256').update(commitPayload, 'utf8').digest('hex');
    const commitRequestHeaders = {
      'x-amz-date': commitTimestamp,
      'x-amz-security-token': session_token,
      'x-amz-content-sha256': payloadHash
    };
    
    const commitAuthorization = createSignature('POST', commitUrl, commitRequestHeaders, access_key_id, secret_access_key, session_token, commitPayload);
    
    const commitResponse = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'authorization': commitAuthorization,
        'content-type': 'application/json',
        'origin': 'https://jimeng.jianying.com',
        'referer': 'https://jimeng.jianying.com/ai-tool/generate',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'x-amz-date': commitTimestamp,
        'x-amz-security-token': session_token,
        'x-amz-content-sha256': payloadHash,
      },
      body: commitPayload,
    });
    
    if (!commitResponse.ok) {
      const errorText = await commitResponse.text();
      throw new Error(`提交上传失败: ${commitResponse.status} - ${errorText}`);
    }
    
    const commitResult = await commitResponse.json();
    if (commitResult?.ResponseMetadata?.Error) {
      throw new Error(`提交上传失败: ${JSON.stringify(commitResult.ResponseMetadata.Error)}`);
    }
    
    const finalResult = commitResult.Result?.Results?.[0];
    const pluginResult = commitResult.Result?.PluginResult?.[0];
    
    const finalUri = pluginResult?.ImageUri || finalResult?.Uri || "";
    if (!finalUri) {
      throw new Error("未能获取到上传后的图片URI");
    }
    
    logger.info(`图片上传成功: ${finalUri}`);
    return finalUri;
    
  } catch (error) {
    logger.error(`图片上传失败: ${error.message}`);
    throw error;
  }
}

// 图片上传功能：将外部图片URL上传到即梦系统
async function uploadImageFromUrl(imageUrl: string, refreshToken: string): Promise<string> {
  try {
    logger.info(`开始从URL上传图片: ${imageUrl}`);
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`下载外部图片失败: ${imageResponse.status}`);
    }
    const buffer = await imageResponse.arrayBuffer();
    const filename = imageUrl.split('/').pop()?.split('?')[0] || "image.jpg";
    return await uploadImageBuffer(buffer, refreshToken, filename);
  } catch (error) {
    logger.error(`从URL上传图片失败: ${error.message}`);
    throw error;
  }
}


// 图片合成功能：先上传图片，然后进行图生图
export async function generateImageComposition(
  _model: string,
  prompt: string,
  imageUrls: (string | Buffer)[],
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  const model = getModel(_model);
  const draftVersion = getDraftVersion(_model);
  const imageCount = imageUrls.length;

  // 解析分辨率
  const resolutionResult = resolveResolution(resolution, ratio);
  const { width, height, imageRatio, resolutionType } = resolutionResult;

  logger.info(`使用模型: ${_model} 映射模型: ${model} 图生图功能 ${imageCount}张图片 ${width}x${height} (${ratio}@${resolution}) 精细度: ${sampleStrength}`);

  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  // 上传所有输入图片
  const uploadedImageIds: string[] = [];
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const image = imageUrls[i];
      let imageId: string;
      if (typeof image === 'string') {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (URL)...`);
        imageId = await uploadImageFromUrl(image, refreshToken);
      } else {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (Buffer)...`);
        imageId = await uploadImageBuffer(image, refreshToken);
      }
      uploadedImageIds.push(imageId);
      logger.info(`图片 ${i + 1}/${imageCount} 上传成功: ${imageId}`);
    } catch (error) {
      logger.error(`图片 ${i + 1}/${imageCount} 上传失败: ${error.message}`);
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图片上传失败: ${error.message}`);
    }
  }

  logger.info(`所有图片上传完成，开始图生图: ${uploadedImageIds.join(', ')}`);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 构建图生图的 sceneOptions（不包含 benefitCount 以避免扣积分）
  // 注意：sceneOptions 需要是对象，在 metrics_extra 中会被 JSON.stringify
  const sceneOption = {
    type: "image",
    scene: "ImageBasicGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: uploadedImageIds.map(() => ({
      abilityName: "byte_edit",
      strength: sampleStrength,
      source: {
        imageUrl: `blob:https://jimeng.jianying.com/${util.uuid()}`
      }
    })),
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${_model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      data: {
        extend: {
          root_model: model,
        },
        submit_id: submitId,
        metrics_extra: JSON.stringify({
          promptSource: "custom",
          generateCount: 1,
          enterFrom: "click",
          sceneOptions: JSON.stringify([sceneOption]),
          generateId: submitId,
          isRegenerate: false
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: "3.2.9",
          min_features: [],
          is_from_tsn: true,
          version: "3.2.9",
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: "3.0.2",
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now().toString(),
                created_did: "",
              },
              generate_type: "blend",
              abilities: {
                type: "",
                id: util.uuid(),
                blend: {
                  type: "",
                  id: util.uuid(),
                  min_version: "3.2.9",
                  min_features: [],
                  core_param: {
                    type: "",
                    id: util.uuid(),
                    model,
                    prompt: `${'#'.repeat(imageCount * 2)}${prompt}`,
                    sample_strength: sampleStrength,
                    image_ratio: imageRatio,
                    large_image_info: {
                      type: "",
                      id: util.uuid(),
                      height,
                      width,
                      resolution_type: resolutionType
                    },
                    intelligent_ratio: intelligentRatio,
                  },
                  ability_list: uploadedImageIds.map((imageId) => ({
                    type: "",
                    id: util.uuid(),
                    name: "byte_edit",
                    image_uri_list: [imageId],
                    image_list: [{
                      type: "image",
                      id: util.uuid(),
                      source_from: "upload",
                      platform_type: 1,
                      name: "",
                      image_uri: imageId,
                      width: 0,
                      height: 0,
                      format: "",
                      uri: imageId
                    }],
                    strength: 0.5
                  })),
                  prompt_placeholder_info_list: uploadedImageIds.map((_, index) => ({
                    type: "",
                    id: util.uuid(),
                    ability_index: index
                  })),
                  postedit_param: {
                    type: "",
                    id: util.uuid(),
                    generate_type: 0
                  }
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`图生图任务已提交，history_id: ${historyId}，等待生成完成...`);
    
  let status = 20, failCode, item_list = [];
  let pollCount = 0;
  const maxPollCount = 600; // 最多轮询10分钟

  while (pollCount < maxPollCount) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    pollCount++;
    
    if (pollCount % 30 === 0) {
      logger.info(`图生图进度: 第 ${pollCount} 次轮询 (history_id: ${historyId})，当前状态: ${status}，已生成: ${item_list.length} 张图片...`);
    }

    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    });

    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");

    status = result[historyId].status;
    failCode = result[historyId].fail_code;
    item_list = result[historyId].item_list || [];

    // 检查是否已生成图片
    if (item_list.length > 0) {
      logger.info(`图生图完成: 状态=${status}, 已生成 ${item_list.length} 张图片`);
      break;
    }
    
    // 记录详细状态
    if (pollCount % 60 === 0) {
      logger.info(`图生图详细状态: status=${status}, item_list.length=${item_list.length}, failCode=${failCode || 'none'}`);
    }
    
    // 如果状态是完成但图片数量为0，记录并继续等待
    if (status === 10 && item_list.length === 0 && pollCount % 30 === 0) {
      logger.info(`图生图状态已完成但无图片生成: 状态=${status}, 继续等待...`);
    }
  }

  if (pollCount >= maxPollCount) {
    logger.warn(`图生图超时: 轮询了 ${pollCount} 次，当前状态: ${status}，已生成图片数: ${item_list.length}`);
  }

  if (status === 30) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图生图失败，错误代码: ${failCode}`);
  }

  const resultImageUrls = item_list.map((item) => {
    if(!item?.image?.large_images?.[0]?.image_url)
      return item?.common_attr?.cover_url || null;
    return item.image.large_images[0].image_url;
  }).filter(url => url !== null);

  logger.info(`图生图结果: 成功生成 ${resultImageUrls.length} 张图片`);
  return resultImageUrls;
}

// 多图生成函数（支持jimeng-4.0及以上版本）
async function generateMultiImages(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  const model = getModel(_model);

  // 解析分辨率
  const resolutionResult = resolveResolution(resolution, ratio);
  const { width, height, imageRatio, resolutionType } = resolutionResult;

  // 从prompt中提取图片数量，默认为4张
  const targetImageCount = prompt.match(/(\d+)张/) ? parseInt(prompt.match(/(\d+)张/)[1]) : 4;

  logger.info(`使用 ${_model} 多图生成: ${targetImageCount}张图片 ${width}x${height} (${ratio}@${resolution}) 精细度: ${sampleStrength}`);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 构建多图模式的 sceneOptions（不包含 benefitCount 以避免扣积分）
  const sceneOption = {
    type: "image",
    scene: "ImageMultiGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: [],
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${_model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      data: {
        extend: {
          root_model: model,
        },
        submit_id: submitId,
        metrics_extra: JSON.stringify({
          promptSource: "custom",
          generateCount: 1,
          enterFrom: "click",
          sceneOptions: JSON.stringify([sceneOption]),
          generateId: submitId,
          isRegenerate: false,
          templateId: "",
          templateSource: "",
          lastRequestId: "",
          originRequestId: "",
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_MIN_VERSION,
          min_features: [],
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: DRAFT_MIN_VERSION,
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now().toString(),
                created_did: "",
              },
              generate_type: "generate",
              abilities: {
                type: "",
                id: util.uuid(),
                generate: {
                  type: "",
                  id: util.uuid(),
                  core_param: {
                    type: "",
                    id: util.uuid(),
                    model,
                    prompt,
                    negative_prompt: negativePrompt,
                    seed: Math.floor(Math.random() * 100000000) + 2500000000,
                    sample_strength: sampleStrength,
                    image_ratio: imageRatio,
                    large_image_info: {
                      type: "",
                      id: util.uuid(),
                      min_version: DRAFT_MIN_VERSION,
                      height,
                      width,
                      resolution_type: resolutionType,
                    },
                    intelligent_ratio: intelligentRatio,
                  },
                  gen_option: {
                    type: "",
                    id: util.uuid(),
                    generate_all: false,
                  },
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`多图生成任务已提交，submit_id: ${submitId}, history_id: ${historyId}，等待生成 ${targetImageCount} 张图片...`);

  // 直接使用 history_id 轮询生成结果（增加轮询时间）
  let status = 20, failCode, item_list = [];
  let pollCount = 0;
  const maxPollCount = 600; // 最多轮询10分钟（600次 * 1秒）

  while (pollCount < maxPollCount) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 每1秒轮询一次
    pollCount++;
    
    if (pollCount % 30 === 0) {
      logger.info(`多图生成进度: 第 ${pollCount} 次轮询 (history_id: ${historyId})，当前状态: ${status}，已生成: ${item_list.length}/${targetImageCount} 张图片...`);
    }

    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    });

    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");

    status = result[historyId].status;
    failCode = result[historyId].fail_code;
    item_list = result[historyId].item_list || [];

    // 检查是否已生成足够的图片
    if (item_list.length >= targetImageCount) {
      logger.info(`多图生成完成: 状态=${status}, 已生成 ${item_list.length} 张图片`);
      break;
    }
    
    // 记录详细状态
    if (pollCount % 60 === 0) {
      logger.info(`jimeng-4.0 详细状态: status=${status}, item_list.length=${item_list.length}, failCode=${failCode || 'none'}`);
    }
    
    // 如果状态是完成但图片数量不够，记录并继续等待
    if (status === 10 && item_list.length < targetImageCount && pollCount % 30 === 0) {
      logger.info(`jimeng-4.0 状态已完成但图片数量不足: 状态=${status}, 已生成 ${item_list.length}/${targetImageCount} 张图片，继续等待...`);
    }
  }

  if (pollCount >= maxPollCount) {
    logger.warn(`多图生成超时: 轮询了 ${pollCount} 次，当前状态: ${status}，已生成图片数: ${item_list.length}`);
  }

  if (status === 30) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误代码: ${failCode}`);
  }

  const imageUrls = item_list.map((item) => {
    if(!item?.image?.large_images?.[0]?.image_url)
      return item?.common_attr?.cover_url || null;
    return item.image.large_images[0].image_url;
  }).filter(url => url !== null);

  logger.info(`多图生成结果: 成功生成 ${imageUrls.length} 张图片`);
  return imageUrls;
}

export async function generateImages(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  const model = getModel(_model);

  // 解析分辨率
  const resolutionResult = resolveResolution(resolution, ratio);
  const { width, height, imageRatio, resolutionType } = resolutionResult;

  logger.info(`使用模型: ${_model} 映射模型: ${model} ${width}x${height} (${ratio}@${resolution}) 精细度: ${sampleStrength}`);


  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  // 检测是否为多图生成请求
  const isMultiImageRequest = (/jimeng-[45]\.[0-9]/.test(_model)) && (
    prompt.includes("连续") ||
    prompt.includes("绘本") ||
    prompt.includes("故事") ||
    /\d+张/.test(prompt)
  );

  // 如果是多图请求，使用专门的处理逻辑
  if (isMultiImageRequest) {
    return await generateMultiImages(_model, prompt, { ratio, resolution, sampleStrength, negativePrompt, intelligentRatio }, refreshToken);
  }

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 构建 sceneOptions 用于 metrics_extra（不包含 benefitCount 以避免扣积分）
  const sceneOption = {
    type: "image",
    scene: "ImageBasicGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: [],
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${_model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      data: {
        extend: {
          root_model: model,
        },
        submit_id: submitId,
        metrics_extra: JSON.stringify({
          promptSource: "custom",
          generateCount: 1,
          enterFrom: "click",
          sceneOptions: JSON.stringify([sceneOption]),
          generateId: submitId,
          isRegenerate: false,
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_MIN_VERSION,
          min_features: [],
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: DRAFT_MIN_VERSION,
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now().toString(),
                created_did: "",
              },
              generate_type: "generate",
              abilities: {
                type: "",
                id: util.uuid(),
                generate: {
                  type: "",
                  id: util.uuid(),
                  core_param: {
                    type: "",
                    id: util.uuid(),
                    model,
                    prompt,
                    negative_prompt: negativePrompt,
                    seed: Math.floor(Math.random() * 100000000) + 2500000000,
                    sample_strength: sampleStrength,
                    image_ratio: imageRatio,
                    large_image_info: {
                      type: "",
                      id: util.uuid(),
                      min_version: DRAFT_MIN_VERSION,
                      height,
                      width,
                      resolution_type: resolutionType,
                    },
                    intelligent_ratio: intelligentRatio,
                  },
                  gen_option: {
                    type: "",
                    id: util.uuid(),
                    generate_all: false,
                  },
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    }
  );
  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`文生图任务已提交，submit_id: ${submitId}, history_id: ${historyId}，等待生成完成...`);

  let status = 20, failCode, item_list = [];
  let pollCount = 0;
  const maxPollCount = 600; // 最多轮询10分钟

  while (pollCount < maxPollCount) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    pollCount++;

    if (pollCount % 30 === 0) {
      logger.info(`文生图进度: 第 ${pollCount} 次轮询 (history_id: ${historyId})，当前状态: ${status}，已生成: ${item_list.length} 张图片...`);
    }

    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 360,
              height: 240,
              uniq_key: "smart_crop-w:360-h:240",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 240,
              height: 320,
              uniq_key: "smart_crop-w:240-h:320",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 640,
              uniq_key: "smart_crop-w:480-h:640",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    });
    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");

    status = result[historyId].status;
    failCode = result[historyId].fail_code;
    item_list = result[historyId].item_list || [];

    // 检查是否已生成图片
    if (item_list.length > 0) {
      logger.info(`文生图完成: 状态=${status}, 已生成 ${item_list.length} 张图片`);
      break;
    }

    // 记录详细状态
    if (pollCount % 60 === 0) {
      logger.info(`文生图详细状态: status=${status}, item_list.length=${item_list.length}, failCode=${failCode || 'none'}`);
    }

    // 如果状态是完成但图片数量为0，记录并继续等待
    if (status === 10 && item_list.length === 0 && pollCount % 30 === 0) {
      logger.info(`文生图状态已完成但无图片生成: 状态=${status}, 继续等待...`);
    }
  }

  if (pollCount >= maxPollCount) {
    logger.warn(`文生图超时: 轮询了 ${pollCount} 次，当前状态: ${status}，已生成图片数: ${item_list.length}`);
  }

  if (status === 30) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED);
  }

  const imageUrls = item_list.map((item) => {
    if(!item?.image?.large_images?.[0]?.image_url)
      return item?.common_attr?.cover_url || null;
    return item.image.large_images[0].image_url;
  }).filter(url => url !== null);

  logger.info(`文生图结果: 成功生成 ${imageUrls.length} 张图片`);
  return imageUrls;
}

export default {
  generateImages,
  generateImageComposition,
};
