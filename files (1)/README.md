# OBCHÓD — planer tras audytowych stacji paliw

Narzędzie pomaga planiście ułożyć trasy delegacji dla zespołów audytowych:
na podstawie comiesięcznej tabeli ryzyk proponuje, które stacje odwiedzić
i w jakiej kolejności, żeby pogodzić priorytet kontroli z sensowną geografią.

Zastępuje ręczne wyszukiwanie stacji na mapie i dobieranie ich „po drodze".

---

## Spis treści

1. [Jak uruchomić](#jak-uruchomić)
2. [Jak używać](#jak-używać)
3. [Pliki projektu](#pliki-projektu)
4. [Konfiguracja](#konfiguracja)
5. [Aktualizacja bazy stacji](#aktualizacja-bazy-stacji)
6. [Testowanie zmian](#testowanie-zmian)
7. [Edycja kodu w Notatniku](#edycja-kodu-w-notatniku)
8. [Jak działa dobór tras](#jak-działa-dobór-tras)
9. [Znane ograniczenia](#znane-ograniczenia)
10. [Rozwiązywanie problemów](#rozwiązywanie-problemów)

---

## Jak uruchomić

Nie trzeba niczego instalować. Wszystkie pliki muszą leżeć w jednym katalogu.

1. Kliknij dwukrotnie `index.html`.
2. Aplikacja otworzy się w przeglądarce.

Wymagany jest **dostęp do internetu** — mapa, odczyt Excela i liczenie tras
korzystają z usług zewnętrznych (szczegóły w [Znanych ograniczeniach](#znane-ograniczenia)).

---

## Jak używać

**1. Wczytaj tabelę ryzyk.** W lewym panelu kliknij „Wybierz plik" i wskaż
miesięcznego Excela. Pojawi się okno mapowania kolumn — przy każdej kolumnie
wybierz, co zawiera. Kluczowe są dwie: **Nr stacji** i **Waga / ranking ryzyka**.

Zaznacz też, w którą stronę idzie ranking:
- *Wyższe wartości = wyższy priorytet* — gdy większa liczba oznacza pilniejszą kontrolę,
- *Niższe wartości = wyższy priorytet* — gdy plik jest listą rankingową i pozycja 1 jest najpilniejsza.

> **Uwaga:** wczytanie nowej tabeli ryzyk **kasuje wcześniej zbudowane trasy**.
> To celowe — stare trasy odnosiłyby się do nieaktualnych priorytetów.
> Jeśli chcesz zachować poprzedni plan, najpierw zapisz projekt (ikona dyskietki).

**2. Ustaw zespoły.** Podaj liczbę audytorów, a następnie dla każdego wpisz
nazwisko i wybierz **bazę wyjazdu** (Warszawa / Gdańsk).

Stacje trafiają do najbliższej bazy spośród tych, z których ktoś faktycznie
wyjeżdża — zespół z Gdańska nie dostanie stacji spod Krakowa. Jeśli z jednej
bazy jedzie kilka osób, jej stacje dzielone są między nie.

**3. Zbuduj trasy.** Kliknij „Zbuduj trasy". Po prawej pojawią się trzy warianty:
delegacja 1-, 2- i 3-dniowa. Wariant o najwyższej sumie wag ryzyka jest
obramowany na czerwono. Wybierz ten, który pasuje do dostępności zespołu.

**4. Popraw plan, jeśli trzeba.** Przy każdym przystanku są trzy przyciski:

| Przycisk | Działanie |
|---|---|
| ▲ | przesuwa wcześniej, a na granicy dnia — do poprzedniego dnia |
| ▼ | przesuwa później, a na granicy dnia — do następnego dnia |
| ✕ | usuwa stację z trasy i zwalnia ją |

Wolną stację z listy po lewej dodasz do otwartej trasy przyciskiem **+**.

Po każdej zmianie czasy przejazdu są przeliczane. Przy nagłówku dnia widać
jego obciążenie; jeśli zmiana wypchnie dzień ponad limit 11 godzin, pojawi się
czerwone ostrzeżenie.

**5. Odhacz kontrole i wyeksportuj.** Przycisk ✓ przy stacji oznacza ją jako
skontrolowaną. „Eksportuj (CSV)" zapisuje trasę do pliku otwieralnego w Excelu.

**Zapis pracy.** Stan zapisuje się automatycznie w przeglądarce. Ikona dyskietki
eksportuje projekt do pliku `.json` — używaj jej przed większymi zmianami
i do przenoszenia pracy na inny komputer.

---

## Pliki projektu

| Plik | Zawartość | Czy edytować |
|---|---|---|
| `index.html` | struktura strony | rzadko |
| `styles.css` | wygląd | tak, przy zmianach wizualnych |
| `script.js` | logika aplikacji, stan, interfejs | tak |
| `route-engine.js` | algorytm doboru tras i reguły czasu pracy | ostrożnie |
| `stations-db.js` | baza stacji (1954 pozycje) | **nie ręcznie** — patrz niżej |
| `test.html` | strona kontrolna | przy dodawaniu testów |
| `README.md` | ten plik | tak |

`script.js` i `route-engine.js` mają na górze spis sekcji, a każda sekcja
własny baner — szukaj linii z `====`.

---

## Konfiguracja

Prawie wszystko, co warto zmieniać, siedzi w obiekcie `CONFIG` na początku
`script.js` (sekcja 1).

### Dodanie kolejnej bazy

```js
BASES: [
  { id: 'waw', name: 'Warszawa', lat: 52.2297, lng: 21.0122 },
  { id: 'gda', name: 'Gdańsk',   lat: 54.3520, lng: 18.6466 }
  // dopisz tutaj kolejny wiersz
],
```

Współrzędne odczytasz z Map Google: prawy przycisk myszy na punkcie, pierwsza
pozycja w menu to szerokość i długość geograficzna. `id` musi być unikalne
i bez spacji.

### Pozostałe ustawienia

| Ustawienie | Znaczenie | Wartość |
|---|---|---|
| `AUDIT_MIN` | czas jednego audytu w minutach | 120 |
| `PLAN_DAY_OPTIONS` | generowane warianty długości delegacji | `[1, 2, 3]` |
| `MAX_STATIONS_PER_AUDITOR` | limit stacji na audytora | 80 |
| `MAX_STATIONS_TOTAL` | limit stacji na jedno planowanie | 300 |
| `OSRM_URL` | serwer liczący trasy | publiczny serwer demo |
| `NOMINATIM_URL` | serwer zamieniający adresy na współrzędne | publiczny serwer demo |
| `GEOCODE_DELAY_MS` | odstęp między zapytaniami o adresy | 1100 |

> `GEOCODE_DELAY_MS` **nie powinno spaść poniżej 1000**. Regulamin Nominatim
> dopuszcza jedno zapytanie na sekundę; szybsze odpytywanie grozi zablokowaniem
> adresu IP firmy przez OpenStreetMap.

### Reguły czasu pracy

Siedzą w `route-engine.js`, w sekcji „STAŁE — REGUŁY DELEGACJI":

| Stała | Znaczenie | Wartość |
|---|---|---|
| `BASE_DAY_MIN` | budżet czasu na jeden dzień | 8 godz |
| `MAX_DAY_MIN` | twardy limit dobowy | 11 godz |
| `BREAK_MIN` | przerwa doliczana do dnia z aktywnością | 60 min |
| `MULTIDAY_MIN_KM_FROM_BASE` | próg odległości dla delegacji wielodniowych | 100 km |

Próg 100 km oznacza, że do delegacji 2- i 3-dniowych **nie trafiają stacje
bliżej niż 100 km od bazy** — nocleg dla stacji „za rogiem" nie ma uzasadnienia
kosztowego. Dla planu jednodniowego próg nie obowiązuje.

> **Te wartości nie zostały potwierdzone z działem kadr ani prawnym.**
> Przed produkcyjnym użyciem trzeba je zweryfikować — patrz [Znane ograniczenia](#znane-ograniczenia).

---

## Aktualizacja bazy stacji

`stations-db.js` jest **generowany**, nie pisany ręcznie. Zawiera tablicę:

```js
window.STATIONS_DB = [
  { id: 'PL_CODO_1', group: 'PL_CODO', stationNo: '1', name: '...', lat: 52.1, lng: 21.0 },
  ...
];
```

Po regeneracji z nowego Excela **stara praca nie ginie**. Przy starcie aplikacja
scala zapisany stan z bazą według zasady:

- **baza decyduje** o nazwie, współrzędnych i grupie,
- **zapisany stan decyduje** o wadze ryzyka, przypisaniu do trasy i statusie kontroli.

Stacja usunięta z bazy jest zachowywana, jeśli ma nadaną wagę albo należy do
trasy — inaczej trasa straciłaby przystanek. Stacje dodane ręcznie przez import
adresowy (bez numeru stacji) są zachowywane zawsze.

Po każdej regeneracji **uruchom `test.html`** — sprawdzi, czy wszystkie stacje
mają poprawne współrzędne, czy leżą w granicach Polski i czy numery się nie
powtarzają. To wychwyci typowe błędy konwersji z Excela.

---

## Testowanie zmian

Otwórz `test.html` (podwójne kliknięcie). Strona sama przeprowadzi 78 testów
i pokaże zielony albo czerwony pasek.

**Rób to po każdej zmianie w `.js`, zanim otworzysz `index.html`.**

Testy obejmują: integralność bazy stacji, scalanie z zapisanym stanem,
odczyt danych z Excela, reguły czasu pracy, budowę tras, próg 100 km,
podział między audytorów i przydział stacji do baz.

Jeśli testów jest znacznie mniej niż 78, w którymś pliku `.js` jest błąd
składni — naciśnij **F12** i sprawdź zakładkę **Console**.

---

## Edycja kodu w Notatniku

**Kodowanie.** W oknie „Zapisz jako" pilnuj, żeby pole *Kodowanie* pokazywało
**UTF-8**. Zapis jako ANSI rozsypie polskie znaki i aplikacja przestanie działać.

**Podgląd błędów.** W przeglądarce **F12** → zakładka **Console** pokazuje
błędy składni z numerem linii. To zastępuje debugger.

**Nawiasy.** Notatnik ich nie sprawdza, a to najczęstsza przyczyna awarii.
Po edycji zawsze odpal `test.html`.

**Odświeżanie.** Przeglądarka cachuje pliki. Po zmianie naciśnij **Ctrl+F5**.
Jeśli to nie pomoże, w `index.html` podnieś numer przy nazwie pliku:
`script.js?v=2.0` → `script.js?v=2.1`.

**Zawijanie wierszy.** W Notatniku: *Widok → Zawijanie wierszy* — bez tego
długie linie uciekają poza ekran.

---

## Jak działa dobór tras

1. **Przydział do baz** — każda stacja trafia do najbliższej bazy spośród
   używanych; stacje jednej bazy dzielone są między jej audytorów.
2. **Klastrowanie** — podział uwzględnia geografię i wyrównanie obciążenia,
   żeby jeden audytor nie dostał wszystkiego.
3. **Macierz odległości** — serwer OSRM zwraca rzeczywiste czasy przejazdu
   między wszystkimi punktami (nie odległości w linii prostej).
4. **Budowa trasy** — algorytm startuje od stacji o najwyższym ryzyku i dokłada
   kolejne, wybierając te o najlepszym stosunku priorytetu do kosztu objazdu,
   dopóki harmonogram mieści się w limicie dni.
5. **Dopracowanie** — metoda 2-opt odwraca fragmenty trasy, szukając krótszej
   kolejności przy tym samym zestawie stacji.

Powrót do bazy doliczany jest **tylko do ostatniego dnia** — kontrolerzy nocują
tam, gdzie dojadą, i wracają na koniec delegacji.

Algorytm faworyzuje w kolejności: sumę wag ryzyka, liczbę stacji, krótszy czas,
równomierne obciążenie dni.

---

## Znane ograniczenia

**Publiczne serwery demonstracyjne.** Trasy liczy `router.project-osrm.org`,
a adresy zamienia `nominatim.openstreetmap.org`. Oba są serwerami demo bez
gwarancji dostępności i nieprzeznaczonymi do pracy produkcyjnej. Oznacza to też,
że **współrzędne stacji opuszczają sieć firmową**. Do pilotażu u jednego planisty
zwykle akceptowalne; przy szerszym użyciu wymaga decyzji IT o własnej instancji.

**Reguły czasu pracy niezwalidowane.** Limity dnia, przerwa i czas audytu to
przyjęte założenia, nie potwierdzone przepisy. Wymagają weryfikacji z osobą
odpowiedzialną za delegacje przed produkcyjnym użyciem.

**Dane tylko w przeglądarce.** Stan trzymany jest w `localStorage` jednego
komputera. Nie ma wspólnej pracy zespołowej, historii zmian ani kopii zapasowej —
wyczyszczenie danych przeglądarki kasuje pracę. Zabezpieczenie: regularny eksport
projektu do `.json`.

**Zależność od CDN.** Leaflet, SheetJS i fonty ładują się z internetu. Jeśli
firmowa sieć blokuje `unpkg.com` lub `fonts.googleapis.com`, aplikacja nie wstanie.

**Brak modelu wspólnych przejazdów.** Kontrolerzy czasem spotykają się na stacji
i jadą dalej jednym autem, żeby oszczędzić paliwo. Narzędzie tego nie planuje —
zgodnie z obecnym procesem ustalają to między sobą.

**Wyniki nieporównane z planem ręcznym.** Nikt dotąd nie zestawił tras
z aplikacji z tymi, które planista układa sam. Bez takiego porównania nie wiadomo,
o ile narzędzie faktycznie skraca pracę.

---

## Rozwiązywanie problemów

**Mapa się nie ładuje / strona jest pusta.**
Sprawdź połączenie z internetem, potem **F12 → Console**. Jeśli widnieją tam
błędy ładowania `unpkg.com`, firmowa sieć blokuje CDN — to trzeba zgłosić IT.

**„Nie udało się wygenerować planu".**
Najczęstsza przyczyna: wszystkie stacje leżą bliżej niż 100 km od bazy, więc
odpadają z wariantów wielodniowych. Wariant 1-dniowy powinien się wygenerować.

**Import nie dopasował żadnej stacji.**
Sprawdź, czy kolumna z numerem stacji została oznaczona jako „Nr stacji"
i czy numery odpowiadają tym z bazy. Lista niedopasowanych numerów trafia
do konsoli (**F12**).

**Trasa nie chce się przeliczyć po edycji.**
Pojawia się ostrzeżenie „czasy mogą być nieaktualne" — to znaczy, że serwer
OSRM nie odpowiedział. Kolejność jest zapisana, ale czasy pochodzą sprzed zmiany.
Ponów edycję, gdy połączenie wróci.

**Aplikacja zachowuje się dziwnie po aktualizacji plików.**
Naciśnij **Ctrl+F5**. Jeśli nie pomoże, podnieś numer wersji przy nazwach
plików w `index.html`.

**Chcę zacząć od zera.**
Ikona nowego dokumentu w prawym górnym rogu kasuje cały zapisany stan
(baza stacji zostaje).
