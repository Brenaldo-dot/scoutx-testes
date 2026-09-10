// Converte o range do DateRangeFilter pros query params que os 3 endpoints
// de gráfico do dashboard esperam (days=N OU start_date+end_date).
export function rangeToParams(range) {
  if (range.mode === 'custom') {
    return { start_date: range.startDate, end_date: range.endDate }
  }
  return { days: range.days }
}
