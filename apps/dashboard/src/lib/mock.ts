// Mock data for M2 (dashboard shell). Replaced by Supabase + Realtime in M3.
import type { AgentStatus, ApprovalKind, IdleActivity } from '@rizehubhq/shared';

export type Department = 'leadership' | 'ops' | 'growth' | 'dev' | 'design' | 'content' | 'multimedia' | 'qa';

export interface Agent {
  id: string;
  name: string;
  department: Department;
  color: string;
  status: AgentStatus;
  verb?: string;          // "Building", "Writing"… shown next to the name when working
  task?: string;
  progress?: number;
  idle?: IdleActivity;
}

export interface Approval {
  id: string;
  kind: ApprovalKind;
  title: string;
  agentId: string;
  client?: string;
  due: string;
  summary: string;
  qaScore?: number;
}

export interface ActivityItem {
  id: string;
  time: string;
  text: string;
  tone: 'info' | 'success' | 'warning' | 'primary';
}

export const agents: Agent[] = [
  { id: 'coo', name: 'COO', department: 'leadership', color: '#6D4AFF', status: 'working', verb: 'Planning', task: 'Plan: Madam Muse bundle launch', progress: 40 },
  { id: 'ea', name: 'EA & Report Desk', department: 'ops', color: '#3BA7FF', status: 'working', verb: 'Reporting', task: 'Vinyl Icons September report', progress: 65 },
  { id: 'client-success', name: 'Client Success', department: 'ops', color: '#38BDF8', status: 'waiting', task: 'Approve: create workspace for Brisbane Coffee Co', progress: 90 },
  { id: 'pipeline', name: 'Pipeline Desk', department: 'growth', color: '#FFB020', status: 'working', verb: 'Drafting', task: 'Proposal: Shopify speed fix', progress: 55 },
  { id: 'prospector', name: 'Social Prospecting', department: 'growth', color: '#FF7A59', status: 'working', verb: 'Researching', task: 'Lead Finder: 30 AU Shopify stores', progress: 35 },
  { id: 'inbound', name: 'Social + Inbound', department: 'growth', color: '#FF5FA2', status: 'idle', idle: 'coffee' },
  { id: 'job-scout', name: 'Job Scout', department: 'growth', color: '#EAB308', status: 'working', verb: 'Screening', task: '14 new Shopify dev jobs', progress: 70 },
  { id: 'shopify-dev', name: 'Shopify Dev', department: 'dev', color: '#5FBF4A', status: 'working', verb: 'Building', task: 'Madam Muse bundle hero section', progress: 60 },
  { id: 'webflow-dev', name: 'Webflow Dev', department: 'dev', color: '#4353FF', status: 'working', verb: 'Building', task: 'LvlUp Ecosystem CMS page', progress: 25 },
  { id: 'wordpress-dev', name: 'WordPress Dev', department: 'dev', color: '#21759B', status: 'idle', idle: 'ping_pong' },
  { id: 'fullstack-dev', name: 'Full-Stack Dev', department: 'dev', color: '#00C2A8', status: 'working', verb: 'Coding', task: 'Halaxy booking API integration', progress: 45 },
  { id: 'uiux-1', name: 'UI/UX Designer 1', department: 'design', color: '#A259FF', status: 'working', verb: 'Designing', task: 'Bundle page wireframe', progress: 80 },
  { id: 'uiux-2', name: 'UI/UX Designer 2', department: 'design', color: '#C084FC', status: 'idle', idle: 'lounge_sofa' },
  { id: 'graphic-1', name: 'Graphic Designer 1', department: 'design', color: '#F97316', status: 'working', verb: 'Rendering', task: '3 launch ads (1:1, 4:5, 9:16)', progress: 50 },
  { id: 'graphic-2', name: 'Graphic Designer 2', department: 'design', color: '#FB923C', status: 'blocked', task: 'Missing brand fonts for Sagebeet' },
  { id: 'social-1', name: 'Social Media 1', department: 'content', color: '#EC4899', status: 'working', verb: 'Scheduling', task: 'October content calendar', progress: 30 },
  { id: 'social-2', name: 'Social Media 2', department: 'content', color: '#F472B6', status: 'idle', idle: 'ping_pong' },
  { id: 'seo-1', name: 'SEO Writer 1', department: 'content', color: '#22C55E', status: 'working', verb: 'Writing', task: 'Bundle landing copy', progress: 85 },
  { id: 'seo-2', name: 'SEO Writer 2', department: 'content', color: '#4ADE80', status: 'working', verb: 'Writing', task: 'Blog: Shopify speed checklist', progress: 20 },
  { id: 'video-editor', name: 'Video Editor', department: 'multimedia', color: '#E11D48', status: 'working', verb: 'Editing', task: 'Collagen Jelly reel v2', progress: 75 },
  { id: 'sound-engineer', name: 'Sound & Voice', department: 'multimedia', color: '#7C3AED', status: 'idle', idle: 'lobby' },
  { id: 'qa-lead', name: 'QA Lead', department: 'qa', color: '#14B8A6', status: 'working', verb: 'Reviewing', task: 'Landing copy v2 (Madam Muse)', progress: 50 },
];

export const approvals: Approval[] = [
  { id: 'ap1', kind: 'plan', title: 'Plan: Madam Muse bundle launch', agentId: 'coo', client: 'Madam Muse', due: 'Fri, Oct 2', summary: '4 tasks · copy → wireframe → Shopify build, plus 3 ads · est. $0 (free profile)' },
  { id: 'ap2', kind: 'deliverable', title: 'Bundle landing copy', agentId: 'seo-1', client: 'Madam Muse', due: 'Today', summary: '540 words, keyword in H1, 3 CTAs to /bundle', qaScore: 92 },
  { id: 'ap3', kind: 'external_action', title: 'Create RizeHub workspace', agentId: 'client-success', client: 'Brisbane Coffee Co', due: 'Today', summary: 'Account + "shopify-growth" workspace (dry run checked)' },
  { id: 'ap4', kind: 'deliverable', title: 'Lead report: 18 AU Shopify stores', agentId: 'prospector', due: 'Today', summary: '18 qualified leads, 18 outreach drafts', qaScore: 88 },
  { id: 'ap5', kind: 'deliverable', title: 'Job shortlist (5 drafts)', agentId: 'job-scout', due: 'Today', summary: 'Top match: Shopify dev, US agency, $25/h, fit 91', qaScore: 90 },
  { id: 'ap6', kind: 'deliverable', title: 'Collagen Jelly reel v1', agentId: 'video-editor', client: 'IO', due: 'Tomorrow', summary: '28 s, 9:16, captions burned in, −14 LUFS', qaScore: 86 },
  { id: 'ap7', kind: 'external_action', title: 'Publish September report', agentId: 'ea', client: 'Vinyl Icons', due: 'Tomorrow', summary: 'Report + cover email to the client' },
];

export const activity: ActivityItem[] = [
  { id: 'a1', time: '08:00', text: 'Morning brief sent to Telegram', tone: 'info' },
  { id: 'a2', time: '08:30', text: 'You assigned "Madam Muse bundle launch"', tone: 'primary' },
  { id: 'a3', time: '09:15', text: 'QA passed: Vinyl Icons report data (96)', tone: 'success' },
  { id: 'a4', time: '10:00', text: 'Lead Finder found 30 AU Shopify stores', tone: 'info' },
  { id: 'a5', time: '11:20', text: 'QA sent landing copy back: 1 fix', tone: 'warning' },
  { id: 'a6', time: '12:05', text: 'You approved the October content calendar', tone: 'success' },
];

export const kpis = {
  activeAgents: agents.filter((a) => a.status === 'working').length,
  totalAgents: agents.length,
  pendingApprovals: approvals.length,
  tasksDoneToday: 32,
  qaPassRate: 94,
  spendToday: 0,
};

export const IDLE_LABEL: Record<IdleActivity, string> = {
  coffee: 'Coffee break',
  lounge_sofa: 'Relaxing in the lounge',
  lobby: 'Hanging out in the lobby',
  ping_pong: 'Playing ping-pong',
  foosball: 'Playing foosball',
  chat: 'Chatting',
};

export const agentById = Object.fromEntries(agents.map((a) => [a.id, a]));
