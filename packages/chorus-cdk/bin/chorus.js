#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const crypto = __importStar(require("crypto"));
const bcrypt = __importStar(require("bcryptjs"));
const chorus_stack_1 = require("../lib/chorus-stack");
const deploy_mode_1 = require("../lib/deploy-mode");
const app = new cdk.App();
const stackName = app.node.tryGetContext('stackName') || 'Chorus';
const acmCertificateArn = app.node.tryGetContext('acmCertificateArn') || '';
const customDomain = app.node.tryGetContext('customDomain') || '';
const superAdminEmail = app.node.tryGetContext('superAdminEmail') || '';
const superAdminPassword = app.node.tryGetContext('superAdminPassword') || '';
const nextAuthSecret = app.node.tryGetContext('nextAuthSecret') ||
    crypto.randomBytes(32).toString('hex');
// Deployment mode: absent or empty resolves to `alb`, anything unrecognised is
// a hard synth error so a typo cannot silently downgrade the front door.
const deployModeRaw = String(app.node.tryGetContext('deployMode') || '').trim();
const deployMode = (deployModeRaw || deploy_mode_1.DEFAULT_DEPLOY_MODE);
if (!deploy_mode_1.DEPLOY_MODES.includes(deployMode)) {
    throw new Error(`deployMode "${deployModeRaw}" is not supported. Accepted values are: ${deploy_mode_1.DEPLOY_MODES.join(', ')}. Pass it via -c deployMode=cloudfront`);
}
/** Region field of an ACM ARN: arn:aws:acm:<region>:<account>:certificate/<id> */
const certificateRegion = (arn) => arn.split(':')[3] || '';
// Validate required parameters
if (deployMode === 'alb') {
    if (!acmCertificateArn) {
        throw new Error('acmCertificateArn is required. Pass it via -c acmCertificateArn=arn:aws:acm:...');
    }
    // ChorusStack is region-agnostic (no `env`), so `stack.region` is a synth-time
    // token and cannot be string-compared. Use the ambient CDK/AWS region instead,
    // and skip the check entirely when neither variable is set.
    const deployRegion = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || '';
    const certRegion = certificateRegion(acmCertificateArn);
    if (deployRegion && certRegion && certRegion !== deployRegion) {
        throw new Error(`acmCertificateArn is from region "${certRegion}" but the deployment region is "${deployRegion}". ` +
            'An ALB listener requires a certificate from its own region. Provide a certificate issued in ' +
            `"${deployRegion}", or deploy into "${certRegion}".`);
    }
}
else {
    // cloudfront mode: the certificate is optional (the distribution falls back to
    // its default *.cloudfront.net certificate), but when supplied it must come
    // from us-east-1 and must be paired with the custom domain it secures.
    const certRegion = certificateRegion(acmCertificateArn);
    if (acmCertificateArn && certRegion !== 'us-east-1') {
        throw new Error(`acmCertificateArn is from region "${certRegion}", but CloudFront alternate domain names require a ` +
            'certificate from us-east-1. Issue or import the certificate in us-east-1, or omit it to use the ' +
            'default CloudFront certificate on the *.cloudfront.net domain.');
    }
    if (Boolean(acmCertificateArn) !== Boolean(customDomain)) {
        throw new Error('customDomain and acmCertificateArn must be supplied together in cloudfront mode: a custom domain ' +
            'cannot be added as an alternate domain name without a certificate, and a certificate has nothing ' +
            'to secure without a domain. Supply both, or neither to use the default CloudFront domain.');
    }
}
if (!superAdminEmail) {
    throw new Error('superAdminEmail is required. Pass it via -c superAdminEmail=admin@example.com');
}
if (!superAdminPassword) {
    throw new Error('superAdminPassword is required. Pass it via -c superAdminPassword=yourpassword');
}
// Hash password at synth time
const superAdminPasswordHash = bcrypt.hashSync(superAdminPassword, 10);
new chorus_stack_1.ChorusStack(app, stackName, {
    deployMode,
    acmCertificateArn,
    customDomain,
    superAdminEmail,
    superAdminPasswordHash,
    nextAuthSecret,
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hvcnVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2hvcnVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMsK0NBQWlDO0FBQ2pDLGlEQUFtQztBQUNuQyxzREFBa0Q7QUFDbEQsb0RBSTRCO0FBRTVCLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLE1BQU0sU0FBUyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFdBQVcsQ0FBQyxJQUFJLFFBQVEsQ0FBQztBQUNsRSxNQUFNLGlCQUFpQixHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLG1CQUFtQixDQUFDLElBQUksRUFBRSxDQUFDO0FBQzVFLE1BQU0sWUFBWSxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNsRSxNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUN4RSxNQUFNLGtCQUFrQixHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlFLE1BQU0sY0FBYyxHQUNsQixHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxnQkFBZ0IsQ0FBQztJQUN4QyxNQUFNLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUV6QywrRUFBK0U7QUFDL0UseUVBQXlFO0FBQ3pFLE1BQU0sYUFBYSxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNoRixNQUFNLFVBQVUsR0FBRyxDQUFDLGFBQWEsSUFBSSxpQ0FBbUIsQ0FBZSxDQUFDO0FBQ3hFLElBQUksQ0FBQywwQkFBWSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO0lBQ3ZDLE1BQU0sSUFBSSxLQUFLLENBQ2IsZUFBZSxhQUFhLDRDQUE0QywwQkFBWSxDQUFDLElBQUksQ0FDdkYsSUFBSSxDQUNMLHdDQUF3QyxDQUMxQyxDQUFDO0FBQ0osQ0FBQztBQUVELGtGQUFrRjtBQUNsRixNQUFNLGlCQUFpQixHQUFHLENBQUMsR0FBVyxFQUFVLEVBQUUsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUUzRSwrQkFBK0I7QUFDL0IsSUFBSSxVQUFVLEtBQUssS0FBSyxFQUFFLENBQUM7SUFDekIsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7UUFDdkIsTUFBTSxJQUFJLEtBQUssQ0FDYixpRkFBaUYsQ0FDbEYsQ0FBQztJQUNKLENBQUM7SUFDRCwrRUFBK0U7SUFDL0UsK0VBQStFO0lBQy9FLDREQUE0RDtJQUM1RCxNQUFNLFlBQVksR0FDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrQkFBa0IsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUM7SUFDakUsTUFBTSxVQUFVLEdBQUcsaUJBQWlCLENBQUMsaUJBQWlCLENBQUMsQ0FBQztJQUN4RCxJQUFJLFlBQVksSUFBSSxVQUFVLElBQUksVUFBVSxLQUFLLFlBQVksRUFBRSxDQUFDO1FBQzlELE1BQU0sSUFBSSxLQUFLLENBQ2IscUNBQXFDLFVBQVUsbUNBQW1DLFlBQVksS0FBSztZQUNqRyw4RkFBOEY7WUFDOUYsSUFBSSxZQUFZLHNCQUFzQixVQUFVLElBQUksQ0FDdkQsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0tBQU0sQ0FBQztJQUNOLCtFQUErRTtJQUMvRSw0RUFBNEU7SUFDNUUsdUVBQXVFO0lBQ3ZFLE1BQU0sVUFBVSxHQUFHLGlCQUFpQixDQUFDLGlCQUFpQixDQUFDLENBQUM7SUFDeEQsSUFBSSxpQkFBaUIsSUFBSSxVQUFVLEtBQUssV0FBVyxFQUFFLENBQUM7UUFDcEQsTUFBTSxJQUFJLEtBQUssQ0FDYixxQ0FBcUMsVUFBVSxxREFBcUQ7WUFDbEcsa0dBQWtHO1lBQ2xHLGdFQUFnRSxDQUNuRSxDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLGlCQUFpQixDQUFDLEtBQUssT0FBTyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUM7UUFDekQsTUFBTSxJQUFJLEtBQUssQ0FDYixtR0FBbUc7WUFDakcsbUdBQW1HO1lBQ25HLDJGQUEyRixDQUM5RixDQUFDO0lBQ0osQ0FBQztBQUNILENBQUM7QUFDRCxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7SUFDckIsTUFBTSxJQUFJLEtBQUssQ0FDYiwrRUFBK0UsQ0FDaEYsQ0FBQztBQUNKLENBQUM7QUFDRCxJQUFJLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztJQUN4QixNQUFNLElBQUksS0FBSyxDQUNiLGdGQUFnRixDQUNqRixDQUFDO0FBQ0osQ0FBQztBQUVELDhCQUE4QjtBQUM5QixNQUFNLHNCQUFzQixHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFFdkUsSUFBSSwwQkFBVyxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUU7SUFDOUIsVUFBVTtJQUNWLGlCQUFpQjtJQUNqQixZQUFZO0lBQ1osZUFBZTtJQUNmLHNCQUFzQjtJQUN0QixjQUFjO0NBQ2YsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGNyeXB0byBmcm9tICdjcnlwdG8nO1xuaW1wb3J0ICogYXMgYmNyeXB0IGZyb20gJ2JjcnlwdGpzJztcbmltcG9ydCB7IENob3J1c1N0YWNrIH0gZnJvbSAnLi4vbGliL2Nob3J1cy1zdGFjayc7XG5pbXBvcnQge1xuICBERUZBVUxUX0RFUExPWV9NT0RFLFxuICBERVBMT1lfTU9ERVMsXG4gIERlcGxveU1vZGUsXG59IGZyb20gJy4uL2xpYi9kZXBsb3ktbW9kZSc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbmNvbnN0IHN0YWNrTmFtZSA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3N0YWNrTmFtZScpIHx8ICdDaG9ydXMnO1xuY29uc3QgYWNtQ2VydGlmaWNhdGVBcm4gPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdhY21DZXJ0aWZpY2F0ZUFybicpIHx8ICcnO1xuY29uc3QgY3VzdG9tRG9tYWluID0gYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnY3VzdG9tRG9tYWluJykgfHwgJyc7XG5jb25zdCBzdXBlckFkbWluRW1haWwgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdzdXBlckFkbWluRW1haWwnKSB8fCAnJztcbmNvbnN0IHN1cGVyQWRtaW5QYXNzd29yZCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ3N1cGVyQWRtaW5QYXNzd29yZCcpIHx8ICcnO1xuY29uc3QgbmV4dEF1dGhTZWNyZXQgPVxuICBhcHAubm9kZS50cnlHZXRDb250ZXh0KCduZXh0QXV0aFNlY3JldCcpIHx8XG4gIGNyeXB0by5yYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2hleCcpO1xuXG4vLyBEZXBsb3ltZW50IG1vZGU6IGFic2VudCBvciBlbXB0eSByZXNvbHZlcyB0byBgYWxiYCwgYW55dGhpbmcgdW5yZWNvZ25pc2VkIGlzXG4vLyBhIGhhcmQgc3ludGggZXJyb3Igc28gYSB0eXBvIGNhbm5vdCBzaWxlbnRseSBkb3duZ3JhZGUgdGhlIGZyb250IGRvb3IuXG5jb25zdCBkZXBsb3lNb2RlUmF3ID0gU3RyaW5nKGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ2RlcGxveU1vZGUnKSB8fCAnJykudHJpbSgpO1xuY29uc3QgZGVwbG95TW9kZSA9IChkZXBsb3lNb2RlUmF3IHx8IERFRkFVTFRfREVQTE9ZX01PREUpIGFzIERlcGxveU1vZGU7XG5pZiAoIURFUExPWV9NT0RFUy5pbmNsdWRlcyhkZXBsb3lNb2RlKSkge1xuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgYGRlcGxveU1vZGUgXCIke2RlcGxveU1vZGVSYXd9XCIgaXMgbm90IHN1cHBvcnRlZC4gQWNjZXB0ZWQgdmFsdWVzIGFyZTogJHtERVBMT1lfTU9ERVMuam9pbihcbiAgICAgICcsICcsXG4gICAgKX0uIFBhc3MgaXQgdmlhIC1jIGRlcGxveU1vZGU9Y2xvdWRmcm9udGAsXG4gICk7XG59XG5cbi8qKiBSZWdpb24gZmllbGQgb2YgYW4gQUNNIEFSTjogYXJuOmF3czphY206PHJlZ2lvbj46PGFjY291bnQ+OmNlcnRpZmljYXRlLzxpZD4gKi9cbmNvbnN0IGNlcnRpZmljYXRlUmVnaW9uID0gKGFybjogc3RyaW5nKTogc3RyaW5nID0+IGFybi5zcGxpdCgnOicpWzNdIHx8ICcnO1xuXG4vLyBWYWxpZGF0ZSByZXF1aXJlZCBwYXJhbWV0ZXJzXG5pZiAoZGVwbG95TW9kZSA9PT0gJ2FsYicpIHtcbiAgaWYgKCFhY21DZXJ0aWZpY2F0ZUFybikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICdhY21DZXJ0aWZpY2F0ZUFybiBpcyByZXF1aXJlZC4gUGFzcyBpdCB2aWEgLWMgYWNtQ2VydGlmaWNhdGVBcm49YXJuOmF3czphY206Li4uJyxcbiAgICApO1xuICB9XG4gIC8vIENob3J1c1N0YWNrIGlzIHJlZ2lvbi1hZ25vc3RpYyAobm8gYGVudmApLCBzbyBgc3RhY2sucmVnaW9uYCBpcyBhIHN5bnRoLXRpbWVcbiAgLy8gdG9rZW4gYW5kIGNhbm5vdCBiZSBzdHJpbmctY29tcGFyZWQuIFVzZSB0aGUgYW1iaWVudCBDREsvQVdTIHJlZ2lvbiBpbnN0ZWFkLFxuICAvLyBhbmQgc2tpcCB0aGUgY2hlY2sgZW50aXJlbHkgd2hlbiBuZWl0aGVyIHZhcmlhYmxlIGlzIHNldC5cbiAgY29uc3QgZGVwbG95UmVnaW9uID1cbiAgICBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9SRUdJT04gfHwgcHJvY2Vzcy5lbnYuQVdTX1JFR0lPTiB8fCAnJztcbiAgY29uc3QgY2VydFJlZ2lvbiA9IGNlcnRpZmljYXRlUmVnaW9uKGFjbUNlcnRpZmljYXRlQXJuKTtcbiAgaWYgKGRlcGxveVJlZ2lvbiAmJiBjZXJ0UmVnaW9uICYmIGNlcnRSZWdpb24gIT09IGRlcGxveVJlZ2lvbikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBhY21DZXJ0aWZpY2F0ZUFybiBpcyBmcm9tIHJlZ2lvbiBcIiR7Y2VydFJlZ2lvbn1cIiBidXQgdGhlIGRlcGxveW1lbnQgcmVnaW9uIGlzIFwiJHtkZXBsb3lSZWdpb259XCIuIGAgK1xuICAgICAgICAnQW4gQUxCIGxpc3RlbmVyIHJlcXVpcmVzIGEgY2VydGlmaWNhdGUgZnJvbSBpdHMgb3duIHJlZ2lvbi4gUHJvdmlkZSBhIGNlcnRpZmljYXRlIGlzc3VlZCBpbiAnICtcbiAgICAgICAgYFwiJHtkZXBsb3lSZWdpb259XCIsIG9yIGRlcGxveSBpbnRvIFwiJHtjZXJ0UmVnaW9ufVwiLmAsXG4gICAgKTtcbiAgfVxufSBlbHNlIHtcbiAgLy8gY2xvdWRmcm9udCBtb2RlOiB0aGUgY2VydGlmaWNhdGUgaXMgb3B0aW9uYWwgKHRoZSBkaXN0cmlidXRpb24gZmFsbHMgYmFjayB0b1xuICAvLyBpdHMgZGVmYXVsdCAqLmNsb3VkZnJvbnQubmV0IGNlcnRpZmljYXRlKSwgYnV0IHdoZW4gc3VwcGxpZWQgaXQgbXVzdCBjb21lXG4gIC8vIGZyb20gdXMtZWFzdC0xIGFuZCBtdXN0IGJlIHBhaXJlZCB3aXRoIHRoZSBjdXN0b20gZG9tYWluIGl0IHNlY3VyZXMuXG4gIGNvbnN0IGNlcnRSZWdpb24gPSBjZXJ0aWZpY2F0ZVJlZ2lvbihhY21DZXJ0aWZpY2F0ZUFybik7XG4gIGlmIChhY21DZXJ0aWZpY2F0ZUFybiAmJiBjZXJ0UmVnaW9uICE9PSAndXMtZWFzdC0xJykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBhY21DZXJ0aWZpY2F0ZUFybiBpcyBmcm9tIHJlZ2lvbiBcIiR7Y2VydFJlZ2lvbn1cIiwgYnV0IENsb3VkRnJvbnQgYWx0ZXJuYXRlIGRvbWFpbiBuYW1lcyByZXF1aXJlIGEgYCArXG4gICAgICAgICdjZXJ0aWZpY2F0ZSBmcm9tIHVzLWVhc3QtMS4gSXNzdWUgb3IgaW1wb3J0IHRoZSBjZXJ0aWZpY2F0ZSBpbiB1cy1lYXN0LTEsIG9yIG9taXQgaXQgdG8gdXNlIHRoZSAnICtcbiAgICAgICAgJ2RlZmF1bHQgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSBvbiB0aGUgKi5jbG91ZGZyb250Lm5ldCBkb21haW4uJyxcbiAgICApO1xuICB9XG4gIGlmIChCb29sZWFuKGFjbUNlcnRpZmljYXRlQXJuKSAhPT0gQm9vbGVhbihjdXN0b21Eb21haW4pKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgJ2N1c3RvbURvbWFpbiBhbmQgYWNtQ2VydGlmaWNhdGVBcm4gbXVzdCBiZSBzdXBwbGllZCB0b2dldGhlciBpbiBjbG91ZGZyb250IG1vZGU6IGEgY3VzdG9tIGRvbWFpbiAnICtcbiAgICAgICAgJ2Nhbm5vdCBiZSBhZGRlZCBhcyBhbiBhbHRlcm5hdGUgZG9tYWluIG5hbWUgd2l0aG91dCBhIGNlcnRpZmljYXRlLCBhbmQgYSBjZXJ0aWZpY2F0ZSBoYXMgbm90aGluZyAnICtcbiAgICAgICAgJ3RvIHNlY3VyZSB3aXRob3V0IGEgZG9tYWluLiBTdXBwbHkgYm90aCwgb3IgbmVpdGhlciB0byB1c2UgdGhlIGRlZmF1bHQgQ2xvdWRGcm9udCBkb21haW4uJyxcbiAgICApO1xuICB9XG59XG5pZiAoIXN1cGVyQWRtaW5FbWFpbCkge1xuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgJ3N1cGVyQWRtaW5FbWFpbCBpcyByZXF1aXJlZC4gUGFzcyBpdCB2aWEgLWMgc3VwZXJBZG1pbkVtYWlsPWFkbWluQGV4YW1wbGUuY29tJyxcbiAgKTtcbn1cbmlmICghc3VwZXJBZG1pblBhc3N3b3JkKSB7XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICAnc3VwZXJBZG1pblBhc3N3b3JkIGlzIHJlcXVpcmVkLiBQYXNzIGl0IHZpYSAtYyBzdXBlckFkbWluUGFzc3dvcmQ9eW91cnBhc3N3b3JkJyxcbiAgKTtcbn1cblxuLy8gSGFzaCBwYXNzd29yZCBhdCBzeW50aCB0aW1lXG5jb25zdCBzdXBlckFkbWluUGFzc3dvcmRIYXNoID0gYmNyeXB0Lmhhc2hTeW5jKHN1cGVyQWRtaW5QYXNzd29yZCwgMTApO1xuXG5uZXcgQ2hvcnVzU3RhY2soYXBwLCBzdGFja05hbWUsIHtcbiAgZGVwbG95TW9kZSxcbiAgYWNtQ2VydGlmaWNhdGVBcm4sXG4gIGN1c3RvbURvbWFpbixcbiAgc3VwZXJBZG1pbkVtYWlsLFxuICBzdXBlckFkbWluUGFzc3dvcmRIYXNoLFxuICBuZXh0QXV0aFNlY3JldCxcbn0pO1xuIl19