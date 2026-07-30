(function () {
  var compactAt = 120;

  function updateRailSize() {
    if (window.innerWidth <= 820) {
      document.body.classList.remove('rail-compact');
      return;
    }
    // 서브 페이지는 처음부터 축소형
    if (!document.body.classList.contains('page-home')) {
      document.body.classList.add('rail-compact');
      return;
    }
    document.body.classList.toggle('rail-compact', window.scrollY > compactAt);
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('.menu-toggle');
    if (toggle) {
      var menu = document.querySelector('.menu');
      if (menu) menu.classList.toggle('is-open');
      return;
    }
    var arrow = event.target.closest('.rail-arrow');
    if (!arrow) return;
    var rail = arrow.parentElement.querySelector('.rail');
    if (!rail) return;
    rail.scrollBy({
      left: arrow.classList.contains('next') ? 720 : -720,
      behavior: 'smooth'
    });
  });

  window.addEventListener('scroll', updateRailSize, { passive: true });
  window.addEventListener('resize', updateRailSize);
  updateRailSize();
})();
