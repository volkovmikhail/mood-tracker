(() => {
  const gridEl = document.getElementById('grid');
  const yearLabel = document.getElementById('yearLabel');
  const prevYearBtn = document.getElementById('prevYear');
  const nextYearBtn = document.getElementById('nextYear');
  const todayBtn = document.getElementById('todayBtn');
  const moodButtons = Array.from(document.querySelectorAll('.mood-btn'));
  const tooltip = document.getElementById('tileTooltip');

  let currentYear = new Date().getFullYear();
  let selectedDate = null; // yyyy-mm-dd
  let dataCache = {}; // date -> mood

  function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getYearRange(year) {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    return { from, to };
  }

  function formatDateForDisplay(dateStr) {
    const date = new Date(dateStr);
    const options = { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    };
    return date.toLocaleDateString('ru-RU', options);
  }

  function showTooltip(event, dateStr) {
    if (!dateStr) return;
    
    const rect = event.target.getBoundingClientRect();
    const gridRect = gridEl.getBoundingClientRect();
    
    tooltip.textContent = formatDateForDisplay(dateStr);
    tooltip.style.left = (rect.left + rect.width / 2) + 'px';
    tooltip.style.top = (rect.top - 10) + 'px';
    tooltip.classList.add('show');
  }

  function hideTooltip() {
    tooltip.classList.remove('show');
  }

  function getWeekOfYear(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return weekNo;
  }

  function renderGrid(year) {
    yearLabel.textContent = year;
    gridEl.innerHTML = '';

    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    
    // Find the first Sunday of the year (or before)
    const firstSunday = new Date(start);
    firstSunday.setDate(start.getDate() - start.getDay());
    
    // Find the last Saturday of the year (or after)
    const lastSaturday = new Date(end);
    lastSaturday.setDate(end.getDate() + (6 - end.getDay()));

    const dayMs = 24 * 60 * 60 * 1000;
    const weeks = [];
    let currentWeek = [];
    
    // Generate all days from first Sunday to last Saturday
    for (let d = new Date(firstSunday); d <= lastSaturday; d = new Date(d.getTime() + dayMs)) {
      currentWeek.push(new Date(d));
      
      // When we have 7 days, start a new week
      if (currentWeek.length === 7) {
        weeks.push([...currentWeek]);
        currentWeek = [];
      }
    }
    
    // Add any remaining days as the last week
    if (currentWeek.length > 0) {
      weeks.push(currentWeek);
    }

    // Render each week as a column
    weeks.forEach(week => {
      week.forEach(day => {
        const el = document.createElement('div');
        el.className = 'tile empty';
        el.dataset.date = formatDate(day);

        // Only show days within the year
        if (day >= start && day <= end) {
          const mood = dataCache[el.dataset.date];
          if (mood) {
            el.className = `tile m${mood}`;
          }
        } else {
          // Days outside the year are invisible but keep structure
          el.style.opacity = '0';
        }

        el.title = el.dataset.date;
        
        // Mouse events for tooltip
        el.addEventListener('mouseenter', (e) => {
          if (day >= start && day <= end) {
            showTooltip(e, el.dataset.date);
          }
        });
        
        el.addEventListener('mouseleave', () => {
          hideTooltip();
        });
        
        el.addEventListener('click', (e) => {
          const today = new Date();
          today.setHours(23, 59, 59, 999); // End of today
          
          if (day >= start && day <= end) {
            if (day <= today) {
              // Past or present date - allow selection
              document.querySelectorAll('.tile.selected').forEach(t => t.classList.remove('selected'));
              el.classList.add('selected');
              selectedDate = el.dataset.date;
              // Show tooltip for selected tile
              showTooltip(e, el.dataset.date);
            } else {
              // Future date - show error modal
              const errorModal = new bootstrap.Modal(document.getElementById('errorModal'));
              errorModal.show();
              // Fix accessibility - remove aria-hidden when modal is shown
              document.getElementById('errorModal').setAttribute('aria-hidden', 'false');
            }
          }
        });

        gridEl.appendChild(el);
      });
    });
  }

  async function fetchYear(year) {
    const { from, to } = getYearRange(year);
    const res = await fetch(`/api/moods?from=${from}&to=${to}`);
    if (!res.ok) {
      return;
    }
    const rows = await res.json();
    console.log('Fetched data from server:', rows);
    rows.forEach(r => { 
      console.log('Processing date:', r.date, 'mood:', r.mood);
      dataCache[r.date] = r.mood; 
    });
  }

  async function saveMood(date, mood) {
    console.log('Saving mood for date:', date, 'mood:', mood);
    const res = await fetch('/api/moods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, mood })
    });
    if (res.ok) {
      dataCache[date] = mood;
      const tile = gridEl.querySelector(`[data-date="${date}"]`);
      if (tile) {
        tile.className = `tile m${mood}`;
      }
      console.log('Successfully saved mood for date:', date);
    } else {
      console.error('Failed to save mood for date:', date);
    }
  }

  moodButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mood = Number(btn.dataset.mood);
      if (!selectedDate) {
        const today = formatDate(new Date());
        selectedDate = today;
      }
      
      // Check if selected date is not in the future
      const selectedDateObj = new Date(selectedDate);
      const today = new Date();
      today.setHours(23, 59, 59, 999); // End of today
      
      if (selectedDateObj > today) {
        const errorModal = new bootstrap.Modal(document.getElementById('errorModal'));
        errorModal.show();
        return;
      }
      
      saveMood(selectedDate, mood);
    });
  });

  prevYearBtn.addEventListener('click', async () => {
    currentYear -= 1;
    await fetchYear(currentYear);
    renderGrid(currentYear);
  });

  nextYearBtn.addEventListener('click', async () => {
    currentYear += 1;
    await fetchYear(currentYear);
    renderGrid(currentYear);
  });

  todayBtn.addEventListener('click', async () => {
    currentYear = new Date().getFullYear();
    await fetchYear(currentYear);
    renderGrid(currentYear);
    const today = formatDate(new Date());
    selectedDate = today; // Update the selectedDate variable
    const tile = gridEl.querySelector(`[data-date="${today}"]`);
    if (tile) {
      document.querySelectorAll('.tile.selected').forEach(t => t.classList.remove('selected'));
      tile.classList.add('selected');
      tile.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  });

  // Fix modal accessibility
  const errorModal = document.getElementById('errorModal');
  errorModal.addEventListener('hidden.bs.modal', () => {
    errorModal.setAttribute('aria-hidden', 'true');
  });

  (async function init() {
    await fetchYear(currentYear);
    renderGrid(currentYear);
  })();
})();


