/**
 * Seed: ensure the recruitment-funnel fields exist on `agencyOffers` and
 * `agencyCareerApplication`. Fully idempotent — anything already present is
 * skipped, so re-running after a partial failure is safe.
 *
 * Run with: bun run --cwd backend seed:recruit
 *
 * Two objects are touched, for two different reasons:
 *
 * - `agencyOffers` gains `funnelType` (LEAD | RECRUITMENT), `careerSlug` (the
 *   agencyCareers row this funnel recruits for) and `applicationConfig` (the
 *   video-submission copy). `funnelType` defaults to the existing behaviour:
 *   a LEAD funnel is the quiz + Calendly booking path, unchanged.
 * - `agencyCareerApplication` gains `videoUrl` (the applicant's submitted
 *   video) and `offerId` (which funnel the application came through), so a
 *   recruiter can trace an applicant back to the page they applied on.
 *
 * NOTE on Twenty APIs: custom OBJECTS and FIELDS are created via the
 * Metadata API (GraphQL `createOneObject` / `createOneField`); RECORDS are
 * created via the REST API (`POST /rest/...`). Mixing them up is the most
 * common source of 400s.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env.local') });

const baseUrl = process.env.TWENTY_BASE_URL?.replace(/\/$/, '') || '';
const apiKey = process.env.TWENTY_API_KEY || '';

if (!baseUrl || !apiKey) {
  console.error('TWENTY_BASE_URL and TWENTY_API_KEY required');
  process.exit(1);
}

const metadataUrl = baseUrl.replace(/\/rest$/, '') + '/metadata';

async function gql(query: string, variables: any) {
  const res = await fetch(metadataUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (!res.ok || json.errors?.length) {
    console.error('METADATA ERRORS', JSON.stringify(json, null, 2));
    throw new Error(JSON.stringify(json.errors) ?? `metadata ${res.status}`);
  }
  return json.data;
}

async function listObjects() {
  const data: any = await gql(
    `query { objects(paging:{first:100}){ edges{ node{ id nameSingular fieldsList{ id name type } } } } }`,
    {},
  );
  return data.objects.edges.map((e: any) => e.node);
}

/** Recruit-funnel fields added to agencyOffers by this script. */
const OFFER_FIELDS = [
  {
    name: 'funnelType',
    label: 'Funnel Type',
    type: 'SELECT',
    description:
      'LEAD = quiz + booking (default, existing behaviour). RECRUITMENT = career questionnaire + video submission, no Calendly.',
    options: [
      { label: 'Lead', value: 'LEAD', color: 'blue', position: 0 },
      { label: 'Recruitment', value: 'RECRUITMENT', color: 'purple', position: 1 },
    ],
  },
  {
    name: 'careerSlug',
    label: 'Career Slug',
    type: 'TEXT',
    description:
      'Slug of the agencyCareers row this funnel recruits for (e.g. cold-caller-appointment-setter). The questionnaire and role copy come from that record.',
  },
  {
    name: 'applicationConfig',
    label: 'Application Config',
    type: 'RAW_JSON',
    description:
      'Video-submission copy: { videoPrompt, videoLabel, videoPlaceholder, videoRequired, submitNote, submittedHeading, submittedBody }',
  },
];

/** Recruit-funnel fields added to agencyCareerApplication by this script. */
const APPLICATION_FIELDS = [
  {
    name: 'videoUrl',
    label: 'Video URL',
    type: 'TEXT',
    description: "Link to the applicant's submitted video (Loom, Vimeo, Drive, YouTube unlisted).",
  },
  {
    name: 'offerId',
    label: 'Offer ID',
    type: 'TEXT',
    description: 'agencyOffers row the application was submitted through, so the funnel is traceable.',
  },
  {
    name: 'videoNote',
    label: 'Video Note',
    type: 'TEXT',
    description: 'Optional context the applicant typed alongside the video link.',
  },
];

async function ensureField(objectId: string, field: any) {
  const res: any = await gql(
    `mutation CreateOneFieldMetadataItem($input: CreateOneFieldMetadataInput!) {
      createOneField(input: $input) { id name type }
    }`,
    {
      input: {
        field: {
          objectMetadataId: objectId,
          isActive: true,
          isNullable: true,
          isUnique: false,
          name: field.name,
          label: field.label,
          type: field.type,
          description: field.description,
          ...(field.options ? { options: field.options } : {}),
        },
      },
    },
  );
  console.log(`  + created field ${res.createOneField.name} (${res.createOneField.type})`);
}

async function ensureFields(nameSingular: string, fields: any[]) {
  const objects = await listObjects();
  const object = objects.find((o: any) => o.nameSingular === nameSingular);
  if (!object) {
    throw new Error(`${nameSingular} object does not exist — run the base seed first`);
  }
  const existing = new Set((object.fieldsList ?? []).map((f: any) => f.name));
  for (const field of fields) {
    if (existing.has(field.name)) {
      console.log(`  = field ${field.name} already exists — skipping`);
      continue;
    }
    await ensureField(object.id, field);
  }
}

async function main() {
  console.log('Ensuring agencyOffers recruit-funnel fields...');
  await ensureFields('agencyOffer', OFFER_FIELDS);

  console.log('Ensuring agencyCareerApplication recruit-funnel fields...');
  await ensureFields('agencyCareerApplication', APPLICATION_FIELDS);

  const verify = await listObjects();
  for (const singular of ['agencyOffer', 'agencyCareerApplication']) {
    const row = verify.find((o: any) => o.nameSingular === singular);
    console.log(`\n${singular}: ${(row?.fieldsList ?? []).map((f: any) => `${f.name}:${f.type}`).join(', ')}`);
  }
  console.log('\nseed:recruit done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
