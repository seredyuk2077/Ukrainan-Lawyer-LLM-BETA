import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import AWS from "aws-sdk";

const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  region: "auto",
  signatureVersion: "v4"
});

const BUCKET = process.env.R2_BUCKET;

const server = new Server(
  { name: "cloudflare-r2", version: "1.0.0" },
  {
    tools: {
      upload_json: {
        description: "Upload JSON to Cloudflare R2",
        parameters: {
          path: { type: "string" },
          body: { type: "object" }
        },
        async run({ path, body }) {
          await s3.putObject({
            Bucket: BUCKET,
            Key: path,
            Body: JSON.stringify(body),
            ContentType: "application/json"
          }).promise();
          return { ok: true, path };
        }
      },
      download_json: {
        description: "Download JSON from Cloudflare R2",
        parameters: {
          path: { type: "string" }
        },
        async run({ path }) {
          const obj = await s3.getObject({
            Bucket: BUCKET,
            Key: path
          }).promise();

          return JSON.parse(obj.Body.toString("utf-8"));
        }
      }
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);


