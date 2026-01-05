import dotenv from "dotenv";
import OAuth from "oauth-1.0a";
import crypto from "crypto";

dotenv.config();

export const netsuiteConfig = {
  baseUrl: process.env.NETSUITE_BASE_URL || "https://3421015-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  realm: process.env.NETSUITE_REALM || "3421015_SB1",
  consumerKey: process.env.NETSUITE_CONSUMER_KEY,
  consumerSecret: process.env.NETSUITE_CONSUMER_SECRET,
  token: process.env.NETSUITE_TOKEN,
  tokenSecret: process.env.NETSUITE_TOKEN_SECRET,
  syncDate: process.env.SYNC_DATE || "20/12/2025"
};

// Initialize OAuth 1.0
const oauth = OAuth({
  consumer: {
    key: netsuiteConfig.consumerKey,
    secret: netsuiteConfig.consumerSecret
  },
  signature_method: 'HMAC-SHA256',
  hash_function(base_string, key) {
    return crypto
      .createHmac('sha256', key)
      .update(base_string)
      .digest('base64');
  }
});

// Function to generate OAuth headers
export const generateOAuthHeaders = (url, method = "GET") => {
  const token = {
    key: netsuiteConfig.token,
    secret: netsuiteConfig.tokenSecret
  };

  const requestData = {
    url: url,
    method: method
  };

  // Generate OAuth 1.0 headers
  const oauthHeaders = oauth.toHeader(oauth.authorize(requestData, token));
  
  // Add realm to the OAuth header
  const authHeader = oauthHeaders['Authorization'] + `, realm="${netsuiteConfig.realm}"`;
  
  return authHeader;
};

// Function to encode URL parameters properly
export const encodeQueryString = (params) => {
  return Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
};