// HRMOS勤怠(IEYASU) APIから残業時間・36協定データを取得して集計するサーバーレス関数
// シークレットキー・会社URLはNetlifyの環境変数（HRMOS_SECRET_KEY / HRMOS_COMPANY_URL）にのみ保持し、ブラウザには渡さない

const hrmosBase = (companyUrl) => `https://ieyasu.co/api/${companyUrl}/v1`;

function hmToMinutes(hm) {
  if (!hm) return 0;
  const m = String(hm).match(/^(-?\d+):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1].startsWith('-') ? -1 : 1;
  const h = Math.abs(parseInt(m[1], 10));
  const mm = parseInt(m[2], 10);
  return sign * (h * 60 + mm);
}

async function getToken(companyUrl, secretKey) {
  const res = await fetch(`${hrmosBase(companyUrl)}/authentication/token`, {
    headers: { Authorization: `Basic ${secretKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HRMOS認証に失敗しました（${res.status}）。シークレットキー・会社URLを確認してください。 ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.token;
}

async function fetchAllPages(url, token) {
  let page = 1;
  let all = [];
  for (;;) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}limit=100&page=${page}`, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HRMOS APIエラー（${res.status}）: ${url} ${body.slice(0, 200)}`);
    }
    const items = await res.json();
    all = all.concat(items);
    const totalCount = Number(res.headers.get('X-Total-Count') || items.length);
    if (all.length >= totalCount || items.length === 0) break;
    page += 1;
    if (page > 50) break; // 安全のための上限
  }
  return all;
}

function monthsInRange(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const companyUrl = process.env.HRMOS_COMPANY_URL;
    const secretKey = process.env.HRMOS_SECRET_KEY;
    if (!companyUrl || !secretKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'サーバー側にHRMOS_COMPANY_URL / HRMOS_SECRET_KEYが設定されていません。Netlifyの環境変数を確認してください。' }),
      };
    }

    const params = event.queryStringParameters || {};
    const { from, to } = params;
    if (!from || !to || !/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'from/to は YYYY-MM 形式で指定してください。' }) };
    }
    const months = monthsInRange(from, to);
    if (months.length === 0 || months.length > 24) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '期間が不正、または長すぎます（最大24ヶ月）。' }) };
    }

    const token = await getToken(companyUrl, secretKey);
    const base = hrmosBase(companyUrl);

    const [users, departments, employments] = await Promise.all([
      fetchAllPages(`${base}/users`, token),
      fetchAllPages(`${base}/departments`, token),
      fetchAllPages(`${base}/employments`, token),
    ]);

    const deptMap = {};
    departments.forEach((d) => { deptMap[d.id] = d.name; });
    const employmentMap = {};
    employments.forEach((emp) => { employmentMap[emp.id] = emp.name; });

    const employees = users
      .filter((u) => !u.end_date) // 退職者（退社日が設定されている社員）は除外
      .map((u) => ({
        id: u.id,
        number: u.number,
        name: `${u.last_name || ''}${u.first_name || ''}`.trim(),
        departmentId: u.department_id,
        department: deptMap[u.department_id] || '',
        employmentId: u.employment_id,
        employment: employmentMap[u.employment_id] || '',
        agreement36Id: u.agreement36_id,
      }));

    const monthlyResults = await Promise.all(
      months.map(async (month) => {
        const rows = await fetchAllPages(`${base}/work_output_months/monthly/${month}`, token);
        return rows.map((r) => ({
          month,
          userId: r.user_id,
          overWorkMin36: hmToMinutes(r.over_work_time_36),
          overWorkMin: hmToMinutes(r.over_work_time),
          totalWorkingMin: hmToMinutes(r.total_working_hours),
          actualWorkingMin: hmToMinutes(r.actual_working_hours),
          prescribedWorkingMin: hmToMinutes(r.prescribed_working_hours),
          inPrescribedWorkingMin: hmToMinutes(r.hours_in_prescribed_working_hours),
          legalHolidayOvertimeMin: hmToMinutes(r.excess_of_statutory_working_hours_in_holidays),
          statutoryHolidayWorkMin: hmToMinutes(r.working_hours_in_statutory_holidays),
          statutoryHolidayWorkDays: parseFloat(r.working_days_in_statutory_holidays) || 0,
          lateNightOvertimeMin: hmToMinutes(r.late_night_overtime_working_hours),
        }));
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ employees, monthly: monthlyResults.flat(), months }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
